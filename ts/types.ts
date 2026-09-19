/**
 * TypeScript mirrors of the Rust engine's types.
 *
 * These describe what `serde` actually emits across the wasm boundary, not
 * what would be idiomatic TypeScript. Where the two disagree — snake_case
 * fields, tuple landmarks, `null` rather than `undefined` — serde wins,
 * because a mirror that is merely nearby is worse than no mirror at all: the
 * compiler stops warning you while the shapes quietly diverge.
 */

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** YuNet's five keypoints, in source frame pixels, as `[x, y]` pairs. */
export interface FaceKeypoints {
  right_eye: [number, number];
  left_eye: [number, number];
  nose: [number, number];
  right_mouth: [number, number];
  left_mouth: [number, number];
}

export interface FaceDetection {
  bbox: BBox;
  score: number;
  /** Optional on the way *in* — the decoder always sets it on the way out. */
  keypoints?: FaceKeypoints | null;
}

/** Absolute head pose. Degrees — note the units differ from `Gaze`. */
export interface HeadPose {
  yaw_deg: number;
  pitch_deg: number;
  roll_deg: number;
}

/**
 * Gaze in **radians**, plus eye-in-head when head pose was available for the
 * same frame. `eye_*` being `null` means "not measurable", never "centred".
 */
export interface Gaze {
  yaw_rad: number;
  pitch_rad: number;
  eye_yaw_rad: number | null;
  eye_pitch_rad: number | null;
}

export interface ObjectDetection {
  class_id: number;
  label: string;
  score: number;
  bbox: BBox;
}

/**
 * What one model slot did on one frame.
 *
 * `not_configured` and `skipped_cadence` are not interchangeable: the first
 * says the signal is unavailable for the whole session, the second says it
 * will be along shortly. Reading either as a benign "nothing detected" is a
 * false-negative generator.
 */
export type SlotState =
  | 'produced'
  | 'skipped_gated'
  | 'skipped_cadence'
  | 'failed'
  | 'not_configured';

/** Why gaze declined to run. Not a blink detector — see the Rust docs. */
export type GateReason =
  | 'no_face'
  | 'low_face_score'
  | 'eyes_too_close'
  | 'eyes_too_far'
  | 'degenerate_box';

export interface SignalCoverage {
  face: SlotState;
  pose: SlotState;
  gaze: SlotState;
  objects: SlotState;
  identity: SlotState;
  gaze_gate?: GateReason | null;
}

export type Horizontal = 'LEFT' | 'CENTER' | 'RIGHT';
export type Vertical = 'UP' | 'CENTER' | 'DOWN';

export interface Axes {
  horizontal: Horizontal;
  vertical: Vertical;
}

/**
 * Plain-language direction labels for the HUD. Each row is `null` when the
 * signal behind it did not run — which must not render the same way as
 * `CENTER`.
 */
export interface DebugDirections {
  head: Axes | null;
  gaze: Axes | null;
  /** Eye-in-head: where the eyes point within their sockets. */
  eye: Axes | null;
  frame_of_reference: 'subject POV' | 'screen POV';
}

/**
 * Everything the models saw in one frame. Pure data, no history.
 *
 * Every field but `seq` and `t_ms` is optional, because the Rust struct is
 * `#[serde(default)]` and this type is used in both directions: you receive a
 * complete one from `endFrame`, and you may hand a sparse one to `replay`.
 */
export interface Signals {
  seq: number;
  /** Milliseconds since session start. Monotonic, not wall clock. */
  t_ms: number;
  faces: FaceDetection[];
  head_pose?: HeadPose | null;
  gaze?: Gaze | null;
  objects?: ObjectDetection[];
  identity_match?: number | null;
  eye_aspect?: unknown | null;
  produced_by: SignalCoverage;
  debug_directions?: DebugDirections | null;
}

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type ViolationKind =
  | 'no_face'
  | 'never_seen'
  | 'multiple_faces'
  | 'head_turned_away'
  | 'gaze_off_screen'
  | 'prohibited_object'
  | 'identity_mismatch'
  | 'signal_lost';

export type SignalSource = 'face' | 'pose' | 'gaze' | 'objects' | 'identity';

/** Which signal argued for a violation, and how strongly. */
export interface Contribution {
  signal: SignalSource;
  weight: number;
  detail: string;
}

export interface EvidenceRef {
  path: string;
  seq: number;
}

export interface Violation {
  kind: ViolationKind;
  severity: Severity;
  confidence: number;
  /** Milliseconds since session start — same timebase as `Signals.t_ms`. */
  t_start_ms: number;
  /** `null` = still ongoing. */
  t_end_ms: number | null;
  subject: string | null;
  evidence: EvidenceRef | null;
  contributing: Contribution[];
}

export type DegradeReason =
  | { reason: 'camera_lost'; detail: string }
  | { reason: 'model_unavailable'; detail: { model: string; why: string } }
  | { reason: 'inference_failing'; detail: { model: string; why: string } }
  | {
      reason: 'execution_provider_fallback';
      detail: { model: string; from: string; to: string };
    };

/**
 * Events are internally tagged on `event`, and the two violation variants
 * flatten the violation itself into the same object.
 */
export type Event =
  | ({ event: 'violation_started' } & Violation)
  | ({ event: 'violation_ended' } & Violation)
  | { event: 'calibration_progress'; pct: number }
  | { event: 'calibration_complete' }
  | ({ event: 'degraded' } & DegradeReason)
  | { event: 'recovered' };

export function isViolationEvent(
  e: Event
): e is ({ event: 'violation_started' } & Violation) | ({ event: 'violation_ended' } & Violation) {
  return e.event === 'violation_started' || e.event === 'violation_ended';
}

/** One open violation and the subject it is about. */
export type ActiveViolation = [ViolationKind, string | null];

/** What one completed frame produced. */
export interface FrameResult {
  signals: Signals;
  events: Event[];
  active: ActiveViolation[];
}

/**
 * The engine configuration. Deliberately loose: it is the Rust `Config`
 * verbatim, every field optional, and pinning it here would mean editing two
 * files every time a threshold is added.
 */
export interface Config {
  capture?: Record<string, unknown>;
  models?: Record<string, unknown>;
  cadence?: {
    face_hz?: number;
    object_hz?: number;
    identity_hz?: number;
  };
  thresholds?: Record<string, any>;
  runtime?: Record<string, unknown>;
}
