/**
 * The browser pipeline, exercised without a browser.
 *
 * Every stage except the four `session.run` calls is in here, so all of it can
 * be driven from a test runner with synthetic pixels and synthetic model
 * outputs. What that buys: a bug in letterbox arithmetic, anchor decoding or
 * slot accounting fails here, in milliseconds, rather than in a camera demo
 * where it is indistinguishable from the model simply not seeing anything.
 */
import { describe, it, expect } from 'bun:test';
import { VigiloPipeline, TensorBag } from '../pkg/vigilo_wasm.js';
import type { FaceDetection, FrameResult, HeadPose, ObjectDetection } from '../ts/types.js';

const WIDTH = 640;
const HEIGHT = 360;

/** An RGBA frame of the sort `getImageData` produces. */
function rgbaFrame(width = WIDTH, height = HEIGHT): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 256;
    data[i * 4 + 1] = (i >> 3) % 256;
    data[i * 4 + 2] = (i >> 5) % 256;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * YuNet's twelve outputs, with one anchor lit up at the given stride.
 *
 * Synthesizing the tensors rather than running the graph is the point: it
 * pins the decode to an input whose correct output can be worked out by hand.
 */
function yunetOutputs(stride: 8 | 16 | 32, anchor: number): TensorBag {
  const bag = new TensorBag();
  for (const s of [8, 16, 32] as const) {
    const cells = (640 / s) ** 2;
    const cls = new Float32Array(cells);
    const obj = new Float32Array(cells);
    const bbox = new Float32Array(cells * 4);
    const kps = new Float32Array(cells * 10);

    if (s === stride) {
      cls[anchor] = 1.0;
      obj[anchor] = 1.0;
      // log-space size: e^1.5 * stride, big enough to look like a real face.
      bbox[anchor * 4 + 2] = 1.5;
      bbox[anchor * 4 + 3] = 1.5;
      // Eye keypoints far enough apart to clear the gaze gate's ratio test.
      kps[anchor * 10] = 0.0; // right eye x, in cell units
      kps[anchor * 10 + 2] = 2.0; // left eye x
    }

    bag.set(`cls_${s}`, cls);
    bag.set(`obj_${s}`, obj);
    bag.set(`bbox_${s}`, bbox);
    bag.set(`kps_${s}`, kps);
  }
  return bag;
}

/**
 * An all-zero bag: the detector ran and saw nobody.
 *
 * Reused across frames by every caller below, because a `TensorBag` owns
 * wasm-side buffers (~1.2 MB for YuNet's twelve heads) that are only reclaimed
 * when a finalizer eventually runs. Allocating one per frame in a loop is what
 * the real runtime avoids too — it keeps exactly one and calls `clear()`.
 */
function emptyOutputs(bag = new TensorBag()): TensorBag {
  bag.clear();
  for (const s of [8, 16, 32] as const) {
    const cells = (640 / s) ** 2;
    bag.set(`cls_${s}`, new Float32Array(cells));
    bag.set(`obj_${s}`, new Float32Array(cells));
    bag.set(`bbox_${s}`, new Float32Array(cells * 4));
    bag.set(`kps_${s}`, new Float32Array(cells * 10));
  }
  return bag;
}

/** A rotation matrix for a yaw of `deg`, row-major, as the pose graph emits. */
function yawMatrix(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  const [s, c] = [Math.sin(r), Math.cos(r)];
  return new Float32Array([c, 0, s, 0, 1, 0, -s, 0, c]);
}

/** 90-bin logits peaked at one bin, as the gaze graph emits. */
function gazeBins(bin: number): Float32Array {
  const logits = new Float32Array(90).fill(-30);
  logits[bin] = 30;
  return logits;
}

describe('VigiloPipeline tensor preparation', () => {
  it('produces input tensors of exactly the shape each graph declares', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);

    expect(pipe.faceInput().length).toBe(3 * 640 * 640);
    expect(pipe.objectInput().length).toBe(3 * 416 * 416);

    // Pose and gaze crop from a face, so they need one to exist first.
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));
    expect(pipe.faceCount()).toBeGreaterThan(0);
    expect(pipe.poseInput().length).toBe(3 * 224 * 224);
    expect(pipe.gazeInput().length).toBe(3 * 448 * 448);
  });

  it('refuses to preprocess before a frame is set', () => {
    // A black tensor would decode to "no face", which fusion reads as the
    // candidate having left. A manufactured violation is worse than an error.
    const pipe = new VigiloPipeline();
    expect(() => pipe.faceInput()).toThrow();
  });

  it('refuses to crop a face that is not there', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    expect(() => pipe.poseInput()).toThrow();
  });

  it('rejects a frame whose buffer is the wrong size for its dimensions', () => {
    const pipe = new VigiloPipeline();
    expect(() => pipe.beginFrame(new Uint8Array(100), WIDTH, HEIGHT)).toThrow();
  });
});

describe('VigiloPipeline decoding', () => {
  it('decodes a planted anchor into a face in source-frame pixels', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);

    // Grid (row 5, col 5) at stride 32 -> centre (160, 160) in the 640x640
    // letterboxed input. The frame is already 640 wide, so scale is 1 and the
    // centre survives unchanged.
    const faces = pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5)) as FaceDetection[];
    expect(faces.length).toBe(1);

    const size = Math.exp(1.5) * 32;
    expect(faces[0].bbox.x).toBeCloseTo(160 - size / 2, 1);
    expect(faces[0].bbox.y).toBeCloseTo(160 - size / 2, 1);
    expect(faces[0].score).toBeCloseTo(1.0, 5);
    expect(faces[0].keypoints).not.toBeNull();
  });

  it('decodes a rotation matrix into signed Euler angles', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));

    const pose = pipe.decodePose(yawMatrix(30)) as HeadPose;
    expect(pose.yaw_deg).toBeCloseTo(30, 1);
    expect(pose.pitch_deg).toBeCloseTo(0, 1);

    expect((pipe.decodePose(yawMatrix(-25)) as HeadPose).yaw_deg).toBeCloseTo(-25, 1);
  });

  it('rejects a rotation matrix that is not nine elements', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    expect(() => pipe.decodePose(new Float32Array(4))).toThrow();
  });

  it('decodes gaze bins over the full Gaze360 span, not a halved one', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));

    // Bin 45 is the midpoint: 45 * 4 - 180 = 0 degrees, straight ahead.
    const centred = pipe.decodeGaze(gazeBins(45), gazeBins(45)) as {
      yaw_rad: number;
      eye_yaw_rad: number | null;
    };
    expect(centred.yaw_rad).toBeCloseTo(0, 2);

    // Bin 89 is the far end: 89 * 4 - 180 = 176 degrees. An MPIIGaze-style
    // +/-90 span would report 88 here.
    const extreme = pipe.decodeGaze(gazeBins(89), gazeBins(45)) as { yaw_rad: number };
    expect((extreme.yaw_rad * 180) / Math.PI).toBeCloseTo(176, 0);
  });

  it('reports eye-in-head only when pose was decoded on the same frame', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));

    // No pose yet: eye-in-head is null, not zero. Zero would read as "eyes
    // centred in their sockets", which is a measurement, not an absence.
    const withoutPose = pipe.decodeGaze(gazeBins(60), gazeBins(45)) as {
      eye_yaw_rad: number | null;
    };
    expect(withoutPose.eye_yaw_rad).toBeNull();

    // Gaze and head pointing the same way means the eyes are centred.
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));
    pipe.decodePose(yawMatrix(60)); // bin 60 -> 60 degrees
    const withPose = pipe.decodeGaze(gazeBins(60), gazeBins(45)) as {
      eye_yaw_rad: number | null;
    };
    expect(withPose.eye_yaw_rad).toBeCloseTo(0, 2);
  });

  it('keeps only allowlisted object classes', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);

    const grid = new Float32Array(3549 * 85);
    const plantAt = (anchor: number, classId: number) => {
      const base = anchor * 85;
      grid[base + 4] = 0.95; // objectness
      grid[base + 5 + classId] = 0.95;
    };
    plantAt(0, 67); // cell phone — allowlisted by default
    plantAt(1, 16); // dog — not

    const objects = pipe.decodeObjects(grid) as ObjectDetection[];
    expect(objects.map((o) => o.label)).toEqual(['cell phone']);
  });
});

describe('VigiloPipeline slot accounting', () => {
  it('marks pose and gaze as gated, not absent, when there is no face', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);

    pipe.decodeFace(emptyOutputs());

    const { signals } = pipe.endFrame(0) as FrameResult;
    expect(signals.produced_by.face).toBe('produced');
    expect(signals.produced_by.pose).toBe('skipped_gated');
    expect(signals.produced_by.gaze).toBe('skipped_gated');
    expect(signals.produced_by.gaze_gate).toBe('no_face');
  });

  it('reports identity as not_configured for the whole session', () => {
    // ArcFace is deliberately absent from the browser build. `not_configured`
    // is the value that tells fusion "never available" rather than "absent
    // right now" — the distinction that stops silence reading as innocence.
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    const { signals } = pipe.endFrame(0) as FrameResult;
    expect(signals.produced_by.identity).toBe('not_configured');
    expect(signals.identity_match).toBeNull();
  });

  it('separates a model that has no session from one that just has not run', () => {
    const pipe = new VigiloPipeline();
    pipe.configureSlots(true, false, false); // only pose was loaded
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));

    const { signals } = pipe.endFrame(0) as FrameResult;
    expect(signals.produced_by.pose).toBe('skipped_cadence');
    expect(signals.produced_by.gaze).toBe('not_configured');
    expect(signals.produced_by.objects).toBe('not_configured');
  });

  it('records a failed inference as failed, not as a clean nothing', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    pipe.decodeFace(yunetOutputs(32, 5 * 20 + 5));
    pipe.markFailed('pose');

    const { signals } = pipe.endFrame(0) as FrameResult;
    expect(signals.produced_by.pose).toBe('failed');
  });

  it('does not carry an object result forward onto later frames', () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);

    const grid = new Float32Array(3549 * 85);
    grid[4] = 0.95;
    grid[5 + 67] = 0.95;
    pipe.decodeObjects(grid);
    const first = pipe.endFrame(0) as FrameResult;
    expect(first.signals.objects ?? []).toHaveLength(1);
    expect(first.signals.produced_by.objects).toBe('produced');

    // The next frame runs no object inference. "There was a phone 900 ms ago"
    // is an inference, and inference belongs to fusion, not to signals.
    pipe.beginFrame(rgbaFrame(), WIDTH, HEIGHT);
    const second = pipe.endFrame(100) as FrameResult;
    expect(second.signals.objects ?? []).toHaveLength(0);
    expect(second.signals.produced_by.objects).toBe('skipped_cadence');
  });
});

describe('VigiloPipeline fusion integration', () => {
  it('raises no_face only after a face has been seen and then lost', () => {
    const pipe = new VigiloPipeline();
    // Only the face model is loaded. With pose, gaze and objects configured
    // but never producing, fusion correctly raises `signal_lost` for them
    // first — true, and not what this test is about.
    pipe.configureSlots(false, false, false);

    const frame = rgbaFrame();
    const empty = emptyOutputs();
    const face = yunetOutputs(32, 5 * 20 + 5);

    const started: string[] = [];
    const ended: string[] = [];
    const step = (t: number, bag: TensorBag) => {
      pipe.beginFrame(frame, WIDTH, HEIGHT);
      pipe.decodeFace(bag);
      for (const e of (pipe.endFrame(t) as FrameResult).events) {
        const kind = (e as unknown as { kind: string }).kind;
        if (e.event === 'violation_started') started.push(kind);
        if (e.event === 'violation_ended') ended.push(kind);
      }
    };

    // A face is present for the first second. Until one has been seen at all,
    // an absence is `never_seen` — a distinct and more serious claim — so
    // `no_face` cannot fire before this.
    for (let t = 0; t <= 1000; t += 100) step(t, face);
    expect(started).toEqual([]);

    // Now nobody. The default hold is 2500 ms, so nothing fires for the first
    // two seconds of silence: a hold that fires immediately is not a hold.
    for (let t = 1100; t <= 3000; t += 100) step(t, empty);
    expect(started).toEqual([]);

    for (let t = 3100; t <= 5000; t += 100) step(t, empty);
    expect(started).toEqual(['no_face']);

    // Face returns: the violation closes after the 500 ms clear hold.
    for (let t = 5100; t <= 7000; t += 100) step(t, face);
    expect(ended).toEqual(['no_face']);
  });

  it('replays to a byte-identical event sequence', () => {
    // The property the whole architecture exists to preserve: fusion is a pure
    // function of its inputs and `t_ms`. Two runs over the same frames must
    // not differ, or no threshold change can ever be diffed against a corpus.
    const frame = rgbaFrame();
    const bag = emptyOutputs();

    const run = () => {
      const pipe = new VigiloPipeline();
      const events: unknown[] = [];
      for (let t = 0; t <= 8000; t += 100) {
        pipe.beginFrame(frame, WIDTH, HEIGHT);
        pipe.decodeFace(bag);
        events.push(...(pipe.endFrame(t) as FrameResult).events);
      }
      events.push(...(pipe.finish(8000) as unknown[]));
      return JSON.stringify(events);
    };

    expect(run()).toBe(run());
  });

  it('closes open violations when the session finishes', () => {
    const pipe = new VigiloPipeline();
    const frame = rgbaFrame();
    const bag = emptyOutputs();
    for (let t = 0; t <= 6000; t += 100) {
      pipe.beginFrame(frame, WIDTH, HEIGHT);
      pipe.decodeFace(bag);
      pipe.endFrame(t);
    }

    const closing = pipe.finish(6000) as Array<{ event: string; t_end_ms: number | null }>;
    expect(closing.length).toBeGreaterThan(0);
    expect(closing.every((e) => e.event === 'violation_ended')).toBe(true);
    expect(closing.every((e) => e.t_end_ms !== null)).toBe(true);
  });
});
