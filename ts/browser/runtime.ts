/**
 * The detection loop — the browser's replacement for `pipeline/workers.rs`.
 *
 * The native engine runs four threads over a lock-free triple-buffered frame
 * bus. A browser tab has one thread, so the structure changes and the
 * guarantees do not:
 *
 * - **Stale frames are dropped, never queued.** The loop samples the camera at
 *   the top of each tick and the camera keeps no history, so a tick that
 *   overruns its budget resumes on a *current* frame. Latency stays bounded by
 *   one inference pass instead of growing without limit, which is what the
 *   frame bus bought natively.
 * - **Slow models run at their own cadence.** Objects are a 1 Hz signal
 *   against a 10 Hz face loop, exactly as in `CadenceConfig`. Pose and gaze
 *   get their own divisors because the gaze model at 448x448 is the single
 *   most expensive thing in the pipeline.
 * - **Fusion still owns every temporal claim.** Nothing here decides anything.
 *   It moves tensors and calls `endFrame`, and the Rust engine — the same code,
 *   the same thresholds, the same replay corpus — decides what it all means.
 *
 * # The background-tab problem
 *
 * A hidden tab has its timers clamped to roughly 1 Hz, and there is no way to
 * opt out. For proctoring that matters: it is indistinguishable, from inside
 * the page, from a candidate who covered the camera. The loop therefore
 * watches `visibilitychange` and reports a `degraded` event when the tab is
 * hidden, so the gap appears in the session record as a period the system
 * could not see rather than as a stretch of clean frames.
 */

import type { InferenceSession } from 'onnxruntime-web';
import type { VigiloPipeline, TensorBag } from '../../pkg/vigilo_wasm.js';
import { vigilo } from '../wasm.js';
import type {
  ActiveViolation,
  Config,
  Event,
  FrameResult,
  Signals,
  Violation,
} from '../types.js';
import type { CameraSource } from './camera.js';
import type { LoadedModels, OrtLike } from './models.js';

export interface RuntimeOptions {
  camera: CameraSource;
  models: LoadedModels;
  /** Thresholds and cadences. Defaults to the engine's own defaults. */
  config?: Config | string;
  /** The `onnxruntime-web` namespace, if you loaded it yourself. */
  ort?: OrtLike;
  /**
   * Face-loop rate. This paces the whole pipeline.
   *
   * Defaults to 10 Hz rather than the native 15, and even that is a ceiling
   * rather than a promise. Measured warm on ORT-web's single-threaded wasm
   * provider (`bun run bench`):
   *
   * ```text
   * face  (YuNet 640)        51 ms
   * pose  (MobileNetV3 224)  13 ms
   * gaze  (MobileOne 448)   104 ms
   * objects (YOLOX 416)      75 ms
   * ```
   *
   * So a full face+pose+gaze pass is ~168 ms — 6 Hz — and with `gazeEvery: 2`
   * it averages ~116 ms, or roughly 8 Hz before preprocessing and canvas
   * readback. The loop self-corrects, so setting a target it cannot meet
   * costs nothing; it simply runs flat out. WebGPU changes these numbers
   * substantially where it is available.
   */
  faceHz?: number;
  /** Object-detector rate. A phone does not appear for 400 ms. */
  objectHz?: number;
  /** Run head pose on every Nth face frame. It is the cheapest of the three. */
  poseEvery?: number;
  /**
   * Run gaze on every Nth face frame.
   *
   * Defaults to 2, and this is the first knob to turn when frames are slow:
   * gaze alone is roughly twice the cost of the face and pose models
   * together, so halving it nearly halves the loop.
   */
  gazeEvery?: number;
}

export type EventListener = (event: Event) => void;
export type ViolationListener = (violation: Violation) => void;
export type FrameListener = (frame: FrameOutcome) => void;

/** One completed pass, with the timings that say where it went. */
export interface FrameOutcome extends FrameResult {
  /** Wall-clock milliseconds for the whole tick, capture included. */
  total_ms: number;
  /** Per-slot inference milliseconds. Absent slots did not run this frame. */
  stages: Partial<Record<'face' | 'pose' | 'gaze' | 'objects', number>>;
}

export interface Latencies {
  fps: number;
  frames: number;
  /** Median and 95th percentile of the whole tick, in milliseconds. */
  total_p50: number;
  total_p95: number;
  stages: Partial<Record<'face' | 'pose' | 'gaze' | 'objects', number>>;
}

const DEFAULTS = {
  faceHz: 10,
  objectHz: 1,
  poseEvery: 1,
  gazeEvery: 2,
};

export class VigiloBrowser {
  readonly pipeline: VigiloPipeline;

  private camera: CameraSource;
  private models: LoadedModels;
  private ort: OrtLike;
  private bag: TensorBag;

  private faceHz: number;
  private objectHz: number;
  private poseEvery: number;
  private gazeEvery: number;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private frameIndex = 0;
  private lastObjectMs = -Infinity;
  private lastTMs = 0;

  private totalSamples = new RingBuffer(120);
  private stageSamples = {
    face: new RingBuffer(120),
    pose: new RingBuffer(120),
    gaze: new RingBuffer(120),
    objects: new RingBuffer(30),
  };

  private eventListeners = new Set<EventListener>();
  private startedListeners = new Set<ViolationListener>();
  private endedListeners = new Set<ViolationListener>();
  private frameListeners = new Set<FrameListener>();
  private onVisibility: (() => void) | null = null;

  private constructor(options: RuntimeOptions, ort: OrtLike) {
    const { VigiloPipeline: Pipeline, TensorBag: Bag } = vigilo();

    const configStr =
      typeof options.config === 'object' ? JSON.stringify(options.config) : options.config;
    this.pipeline = new Pipeline(configStr);
    this.bag = new Bag();

    this.camera = options.camera;
    this.models = options.models;
    this.ort = ort;

    // A model that failed to download is `not_configured` for the session, not
    // absent on this frame. Fusion reads those two very differently.
    this.pipeline.configureSlots(
      !!options.models.pose,
      !!options.models.gaze,
      !!options.models.objects
    );

    const cadence = (this.pipeline.config() as Config)?.cadence ?? {};
    this.faceHz = options.faceHz ?? DEFAULTS.faceHz;
    this.objectHz = options.objectHz ?? cadence.object_hz ?? DEFAULTS.objectHz;
    this.poseEvery = Math.max(1, options.poseEvery ?? DEFAULTS.poseEvery);
    this.gazeEvery = Math.max(1, options.gazeEvery ?? DEFAULTS.gazeEvery);
  }

  static async create(options: RuntimeOptions): Promise<VigiloBrowser> {
    const ort = options.ort ?? ((await import('onnxruntime-web')) as unknown as OrtLike);
    const runtime = new VigiloBrowser(options, ort);

    // Report the models that did not load, once, at the point it is still
    // actionable — rather than leaving a caller to infer it from a signal that
    // never arrives.
    for (const { slot, error } of options.models.failed) {
      runtime.dispatch({
        event: 'degraded',
        reason: 'model_unavailable',
        detail: { model: slot, why: error },
      } as Event);
    }
    return runtime;
  }

  // -- lifecycle --------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.frameIndex = 0;
    this.lastObjectMs = -Infinity;
    this.watchVisibility();
    void this.tick();
  }

  /** Stop the loop. Temporal state is kept, so `start()` resumes the session. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
  }

  /**
   * End the session, closing every violation still open.
   *
   * Without this a violation that was open when the page unloaded never gets
   * an end event, and reads as zero-length in the report.
   */
  finish(): Event[] {
    this.stop();
    const events = this.pipeline.finish(this.lastTMs) as Event[];
    for (const event of events) this.dispatch(event);
    return events;
  }

  /** Drop all temporal state. Thresholds and loaded models are kept. */
  reset(): void {
    this.pipeline.reset();
    this.startedAt = performance.now();
    this.frameIndex = 0;
    this.lastTMs = 0;
  }

  // -- subscriptions ----------------------------------------------------

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onViolationStarted(fn: ViolationListener): () => void {
    this.startedListeners.add(fn);
    return () => this.startedListeners.delete(fn);
  }

  onViolationEnded(fn: ViolationListener): () => void {
    this.endedListeners.add(fn);
    return () => this.endedListeners.delete(fn);
  }

  /** Every completed frame: signals, events and timings. Use this to draw. */
  onFrame(fn: FrameListener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private lastActive: ActiveViolation[] = [];

  /** Violations open right now, as of the last completed frame. */
  get active(): ActiveViolation[] {
    return this.lastActive;
  }

  get latencies(): Latencies {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    return {
      fps: elapsed > 0 ? this.frameIndex / elapsed : 0,
      frames: this.frameIndex,
      total_p50: this.totalSamples.percentile(0.5),
      total_p95: this.totalSamples.percentile(0.95),
      stages: {
        face: this.stageSamples.face.percentile(0.5),
        pose: this.stageSamples.pose.percentile(0.5),
        gaze: this.stageSamples.gaze.percentile(0.5),
        objects: this.stageSamples.objects.percentile(0.5),
      },
    };
  }

  // -- the loop ---------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) return;
    const tickStart = performance.now();

    try {
      await this.runFrame(tickStart);
    } catch (error) {
      // Degrade, never die. One bad frame is not a reason to end an exam.
      this.dispatch({
        event: 'degraded',
        reason: 'inference_failing',
        detail: { model: 'pipeline', why: String(error) },
      } as Event);
    }

    if (!this.running) return;

    // Self-correcting pace: aim for the next multiple of the period rather
    // than "period milliseconds from whenever this finished", so a slow frame
    // is absorbed instead of permanently shifting the schedule.
    const period = 1000 / Math.max(0.1, this.faceHz);
    const elapsed = performance.now() - tickStart;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, period - elapsed));
  }

  private async runFrame(tickStart: number): Promise<void> {
    const image = this.camera.grab();
    const t_ms = tickStart - this.startedAt;
    this.lastTMs = t_ms;
    this.frameIndex += 1;

    this.pipeline.beginFrame(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height
    );

    const stages: FrameOutcome['stages'] = {};

    // -- face ---------------------------------------------------------
    let faceCount = 0;
    try {
      const started = performance.now();
      const outputs = await this.run(this.models.face, this.pipeline.faceInput(), [1, 3, 640, 640]);
      stages.face = performance.now() - started;
      this.stageSamples.face.push(stages.face);

      this.bag.clear();
      for (const [name, tensor] of Object.entries(outputs)) {
        this.bag.set(name, tensor.data as Float32Array);
      }
      this.pipeline.decodeFace(this.bag);
      faceCount = this.pipeline.faceCount();
    } catch (error) {
      this.pipeline.markFailed('face');
      this.warn('face', error);
    }

    // -- head pose ----------------------------------------------------
    // Pose before gaze, on the same frame, because eye-in-head is their
    // difference and a difference of two different instants is not one.
    const poseDue = this.frameIndex % this.poseEvery === 0;
    if (this.models.pose && faceCount > 0 && poseDue) {
      try {
        const started = performance.now();
        const outputs = await this.run(
          this.models.pose,
          this.pipeline.poseInput(),
          [1, 3, 224, 224]
        );
        stages.pose = performance.now() - started;
        this.stageSamples.pose.push(stages.pose);

        const rotation = pick(outputs, 'rotation_matrix');
        this.pipeline.decodePose(rotation);
      } catch (error) {
        this.pipeline.markFailed('pose');
        this.warn('pose', error);
      }
    }

    // -- gaze ---------------------------------------------------------
    const gazeDue = this.frameIndex % this.gazeEvery === 0;
    if (this.models.gaze && faceCount > 0 && gazeDue) {
      // Ask before preprocessing: a gated frame skips a 448x448 resize and the
      // heaviest inference in the pipeline, and records *why* it skipped.
      const gate = this.pipeline.gazeGate();
      if (gate === null || gate === undefined) {
        try {
          const started = performance.now();
          const outputs = await this.run(
            this.models.gaze,
            this.pipeline.gazeInput(),
            [1, 3, 448, 448]
          );
          stages.gaze = performance.now() - started;
          this.stageSamples.gaze.push(stages.gaze);

          this.pipeline.decodeGaze(pick(outputs, 'yaw'), pick(outputs, 'pitch'));
        } catch (error) {
          this.pipeline.markFailed('gaze');
          this.warn('gaze', error);
        }
      }
    }

    // -- objects ------------------------------------------------------
    // Its own clock, not a frame divisor: the object rate is expressed in Hz
    // in `CadenceConfig` and must not drift when the face loop slows down.
    const objectPeriod = 1000 / Math.max(0.01, this.objectHz);
    if (this.models.objects && t_ms - this.lastObjectMs >= objectPeriod) {
      this.lastObjectMs = t_ms;
      try {
        const started = performance.now();
        const outputs = await this.run(
          this.models.objects,
          this.pipeline.objectInput(),
          [1, 3, 416, 416]
        );
        stages.objects = performance.now() - started;
        this.stageSamples.objects.push(stages.objects);

        this.pipeline.decodeObjects(pick(outputs, 'output'));
      } catch (error) {
        this.pipeline.markFailed('objects');
        this.warn('objects', error);
      }
    }

    // -- fusion -------------------------------------------------------
    const result = this.pipeline.endFrame(t_ms) as FrameResult;
    this.lastActive = result.active;

    const total_ms = performance.now() - tickStart;
    this.totalSamples.push(total_ms);

    for (const event of result.events) this.dispatch(event);
    const outcome: FrameOutcome = { ...result, total_ms, stages };
    for (const listener of this.frameListeners) listener(outcome);
  }

  private async run(
    session: InferenceSession,
    input: Float32Array,
    dims: number[]
  ): Promise<Record<string, { data: unknown }>> {
    const tensor = new this.ort.Tensor('float32', input, dims);
    const feeds = { [session.inputNames[0]]: tensor } as Record<string, never>;
    return (await session.run(feeds)) as unknown as Record<string, { data: unknown }>;
  }

  private dispatch(event: Event): void {
    for (const listener of this.eventListeners) listener(event);
    if (event.event === 'violation_started') {
      for (const listener of this.startedListeners) listener(event as unknown as Violation);
    } else if (event.event === 'violation_ended') {
      for (const listener of this.endedListeners) listener(event as unknown as Violation);
    }
  }

  private warn(model: string, error: unknown): void {
    this.dispatch({
      event: 'degraded',
      reason: 'inference_failing',
      detail: { model, why: String(error) },
    } as Event);
  }

  /**
   * A hidden tab is a blind spot, and it must show up as one.
   *
   * Timer clamping in a background tab drops the loop to roughly 1 Hz. From
   * inside the page that is indistinguishable from a covered camera, and
   * silence must never read as innocence.
   */
  private watchVisibility(): void {
    if (typeof document === 'undefined') return;
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.dispatch({
          event: 'degraded',
          reason: 'camera_lost',
          detail: 'tab hidden — browser throttles the detection loop while backgrounded',
        } as Event);
      } else {
        this.dispatch({ event: 'recovered' } as Event);
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }
}

/**
 * Pull one named output, falling back to the sole tensor when the export used
 * a different name. A graph re-exported with default names is a rename, not a
 * different model, and failing the whole session over it would be a poor trade.
 */
function pick(outputs: Record<string, { data: unknown }>, name: string): Float32Array {
  const named = outputs[name];
  if (named) return named.data as Float32Array;

  const values = Object.values(outputs);
  if (values.length === 1) return values[0].data as Float32Array;

  throw new Error(
    `expected an output named "${name}", got: ${Object.keys(outputs).join(', ')}`
  );
}

/** Fixed-size window of recent samples, for percentiles without unbounded growth. */
class RingBuffer {
  private data: number[] = [];
  private next = 0;

  constructor(private capacity: number) {}

  push(value: number): void {
    if (this.data.length < this.capacity) {
      this.data.push(value);
    } else {
      this.data[this.next] = value;
      this.next = (this.next + 1) % this.capacity;
    }
  }

  percentile(p: number): number {
    if (this.data.length === 0) return 0;
    const sorted = [...this.data].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[index];
  }
}

export type { Signals };
