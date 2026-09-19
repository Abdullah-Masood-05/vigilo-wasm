import type {
  Signals,
  Event,
  Violation,
  ViolationKind,
  Config,
  DebugDirections,
} from './types.js';
import { vigilo } from './wasm.js';

export type ViolationListener = (violation: Violation) => void;
export type EventListener = (event: Event) => void;

/**
 * High-level Proctoring Session Manager.
 * Orchestrates real-time frame signals, emits clean typed events, and tracks violations.
 */
export class ProctorSession {
  private engine: any;
  private tracker: any;
  private violationStartedListeners: Set<ViolationListener> = new Set();
  private violationEndedListeners: Set<ViolationListener> = new Set();
  private eventListeners: Set<EventListener> = new Set();
  private lastTimestampMs: number = 0;

  /** Requires `initVigilo()` to have been awaited. */
  constructor(config?: Config | string) {
    const wasm = vigilo();
    const configStr = typeof config === 'object' ? JSON.stringify(config) : config;
    this.engine = new wasm.WasmFusionEngine(configStr);
    this.tracker = new wasm.WasmDirectionTracker();
  }

  /**
   * Process a single incoming frame of proctoring signals.
   * Dispatches events to registered listeners and returns new events.
   */
  public step(signals: Signals, timestampMs?: number): Event[] {
    // `signals.t_ms` is milliseconds since session start. The fallback used to
    // be `Date.now()`, which is a wall-clock epoch — mixing the two puts a
    // ~1.7e12 ms jump into the middle of a monotonic timebase, and every hold
    // timer and decay window downstream reads that as an eternity elapsing
    // between two consecutive frames.
    const t_ms = timestampMs ?? signals.t_ms ?? this.lastTimestampMs;
    this.lastTimestampMs = t_ms;

    const events: Event[] = this.engine.step(signals, t_ms);

    for (const ev of events) {
      this.eventListeners.forEach((listener) => listener(ev));

      if (ev.event === 'violation_started') {
        this.violationStartedListeners.forEach((listener) => listener(ev));
      } else if (ev.event === 'violation_ended') {
        this.violationEndedListeners.forEach((listener) => listener(ev));
      }
    }

    return events;
  }

  /**
   * Update direction tracker and obtain plain-language orientation labels.
   */
  public updateDirection(
    headYawDeg?: number,
    headPitchDeg?: number,
    gazeYawRad?: number,
    gazePitchRad?: number
  ): DebugDirections {
    return this.tracker.update(
      headYawDeg,
      headPitchDeg,
      gazeYawRad,
      gazePitchRad
    );
  }

  /**
   * List of violation kinds currently open and active.
   */
  public getActiveViolations(): ViolationKind[] {
    return this.engine.active();
  }

  /**
   * Detailed list of active violations with their subject strings.
   */
  public getActiveViolationDetails(): Array<[ViolationKind, string | null]> {
    return this.engine.active_detail();
  }

  /**
   * Subscribe to violation started events.
   */
  public onViolationStarted(listener: ViolationListener): () => void {
    this.violationStartedListeners.add(listener);
    return () => this.violationStartedListeners.delete(listener);
  }

  /**
   * Subscribe to violation ended events.
   */
  public onViolationEnded(listener: ViolationListener): () => void {
    this.violationEndedListeners.add(listener);
    return () => this.violationEndedListeners.delete(listener);
  }

  /**
   * Subscribe to all events.
   */
  public onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Conclude the exam session and finalize any open violations.
   */
  public finish(timestampMs?: number): Event[] {
    const t_ms = timestampMs ?? this.lastTimestampMs;
    const finalEvents: Event[] = this.engine.finish(t_ms);

    for (const ev of finalEvents) {
      this.eventListeners.forEach((listener) => listener(ev));
      if (ev.event === 'violation_ended') {
        this.violationEndedListeners.forEach((listener) => listener(ev));
      }
    }

    return finalEvents;
  }

  /**
   * Reset session state.
   */
  public reset(): void {
    this.engine.reset();
  }
}
