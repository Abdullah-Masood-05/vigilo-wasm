/**
 * Pure type definitions for vigilo-wasm.
 * Mirroring the Rust engine's strictly typed structures.
 */

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceKeypoints {
  right_eye: [number, number];
  left_eye: [number, number];
  nose_tip: [number, number];
  mouth_right: [number, number];
  mouth_left: [number, number];
}

export interface FaceDetection {
  bbox: BBox;
  score: number;
  landmarks?: FaceKeypoints | null;
}

export interface HeadPose {
  yaw_deg: number;
  pitch_deg: number;
  roll_deg: number;
}

export interface Gaze {
  yaw_rad: number;
  pitch_rad: number;
  eye_yaw_rad?: number | null;
  eye_pitch_rad?: number | null;
}

export interface ObjectDetection {
  bbox: BBox;
  class_id: number;
  label: string;
  score: number;
}

export type SlotState =
  | 'produced'
  | 'skipped_cadence'
  | 'skipped_gated'
  | 'failed'
  | 'not_configured';

export type GateReason =
  | 'no_face'
  | 'multiple_faces'
  | 'face_too_small'
  | 'eyes_too_close'
  | 'head_turned'
  | 'confidence_low';

export interface SignalCoverage {
  face: SlotState;
  pose: SlotState;
  gaze: SlotState;
  objects: SlotState;
  identity: SlotState;
  gaze_gate?: GateReason | null;
}

export interface Signals {
  seq: number;
  t_ms: number;
  faces: FaceDetection[];
  head_pose?: HeadPose | null;
  gaze?: Gaze | null;
  eye_aspect?: any | null;
  objects: ObjectDetection[];
  identity_match?: number | null;
  produced_by: SignalCoverage;
  debug_directions?: any | null;
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type ViolationKind =
  | 'never_seen'
  | 'no_face'
  | 'multiple_faces'
  | 'head_turned_away'
  | 'gaze_off_screen'
  | 'prohibited_object'
  | 'signal_lost'
  | 'identity_mismatch';

export type SignalSource = 'face' | 'pose' | 'gaze' | 'objects' | 'identity';

export interface Contribution {
  signal: SignalSource;
  weight: number;
  detail: string;
}

export interface Violation {
  kind: ViolationKind;
  severity: Severity;
  confidence: number;
  t_start_ms: number;
  t_end_ms?: number | null;
  subject?: string | null;
  evidence?: string | null;
  contributing: Contribution[];
}

export interface ViolationEventStarted extends Violation {
  event: 'violation_started';
}

export interface ViolationEventEnded extends Violation {
  event: 'violation_ended';
}

export interface CalibrationProgressEvent {
  event: 'calibration_progress';
  pct: number;
}

export interface CalibrationCompleteEvent {
  event: 'calibration_complete';
}

export interface DegradedEvent {
  event: 'degraded';
  reason: string;
  detail?: any;
}

export interface RecoveredEvent {
  event: 'recovered';
}

export type Event =
  | ViolationEventStarted
  | ViolationEventEnded
  | CalibrationProgressEvent
  | CalibrationCompleteEvent
  | DegradedEvent
  | RecoveredEvent;

export interface DirectionResult {
  horizontal: 'LEFT' | 'CENTER' | 'RIGHT';
  vertical: 'UP' | 'CENTER' | 'DOWN';
}

export interface DebugDirections {
  head: DirectionResult;
  gaze: DirectionResult;
}

export interface Config {
  thresholds: any;
  runtime: any;
}
