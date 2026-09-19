# Signals & Detection Types

TypeScript type definitions mirroring the Rust engine's data structures.

```ts
import type {
  Signals,
  BBox,
  FaceDetection,
  FaceKeypoints,
  HeadPose,
  Gaze,
  ObjectDetection,
  SignalCoverage,
  SlotState,
  GateReason,
  DebugDirections,
} from 'vigilo-wasm';
```

---

## `Signals`

The complete snapshot of model detections and coverage for a single frame:

```ts
interface Signals {
  /** Monotonic frame sequence index. */
  seq: number;
  /** Milliseconds since session start. */
  t_ms: number;
  /** Detected faces. */
  faces: FaceDetection[];
  /** Head pose angles (if produced). */
  head_pose?: HeadPose | null;
  /** Gaze angles (if produced). */
  gaze?: Gaze | null;
  /** Detected prohibited objects. */
  objects?: ObjectDetection[];
  /** Identity similarity score (always null in browser runtime). */
  identity_match?: number | null;
  /** Coverage status for each model slot. */
  produced_by: SignalCoverage;
  /** Plain-language direction labels for the HUD. */
  debug_directions?: DebugDirections | null;
}
```

---

## Vision Data Structures

### `BBox`
Bounding box in pixel coordinates of the source frame:
```ts
interface BBox {
  x: number; // Top-left X
  y: number; // Top-left Y
  w: number; // Width
  h: number; // Height
}
```

### `FaceDetection`
```ts
interface FaceDetection {
  bbox: BBox;
  score: number;
  keypoints?: FaceKeypoints | null;
}

interface FaceKeypoints {
  right_eye: [number, number];
  left_eye: [number, number];
  nose: [number, number];
  right_mouth: [number, number];
  left_mouth: [number, number];
}
```

### `HeadPose`
Head orientation angles in **degrees**:
```ts
interface HeadPose {
  yaw_deg: number;   // Positive = turned left (subject POV)
  pitch_deg: number; // Positive = tilted up
  roll_deg: number;  // Positive = tilted right
}
```

### `Gaze`
Gaze orientation in **radians**:
```ts
interface Gaze {
  yaw_rad: number;
  pitch_rad: number;
  /** Eye-in-head angle: difference between gaze ray and head orientation. */
  eye_yaw_rad: number | null;
  eye_pitch_rad: number | null;
}
```

### `ObjectDetection`
```ts
interface ObjectDetection {
  class_id: number;
  label: string; // e.g. "cell phone", "book"
  score: number;
  bbox: BBox;
}
```

---

## Slot States & Gating

### `SlotState`
Describes what each model slot did on this frame:
- `'produced'`: Model ran and produced a valid prediction.
- `'skipped_gated'`: Gaze was gated (e.g. face turned too far or eyes not visible).
- `'skipped_cadence'`: Model skipped due to cadence throttling (e.g. `gazeEvery: 2`).
- `'failed'`: Inference threw an unrecoverable error this frame.
- `'not_configured'`: Model was not provided or failed download.

### `GateReason`
Why gaze declined to evaluate:
- `'no_face'`
- `'low_face_score'`
- `'eyes_too_close'`
- `'eyes_too_far'`
- `'degenerate_box'`
