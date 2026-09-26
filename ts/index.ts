/**
 * vigilo-wasm — the `vigilo-core` proctoring engine, in the browser.
 *
 * Two levels, and most callers want the first:
 *
 * ```ts
 * import { initVigilo, CameraSource, loadModels, VigiloBrowser } from 'vigilo-wasm';
 *
 * await initVigilo();
 * const camera = await CameraSource.open();
 * const models = await loadModels({
 *   face:    '/models/face_detection_yunet_2023mar.onnx',
 *   pose:    '/models/headpose_mobilenetv3_small.onnx',
 *   gaze:    '/models/mobileone_s0_gaze.onnx',
 *   objects: '/models/yolox_nano.onnx',
 * });
 *
 * const vigilo = await VigiloBrowser.create({ camera, models });
 * vigilo.onViolationStarted((v) => console.warn(v.kind, v.subject));
 * vigilo.start();
 * ```
 *
 * The second level is [`ProctorSession`], which takes `Signals` you produced
 * some other way — a recording, a server, your own models — and runs only the
 * fusion engine over them. That is the path for replaying a corpus, and it is
 * the same code the desktop app runs.
 *
 * **Nothing here loads wasm at import time.** `initVigilo()` is explicit and
 * must be awaited before any other export is used.
 */

export * from './types.js';
export { initVigilo, vigilo, isInitializing } from './wasm.js';
export type { VigiloWasm, WasmInput } from './wasm.js';

export { ProctorSession } from './session.js';
export type { ViolationListener, EventListener } from './session.js';

export { CameraSource } from './browser/camera.js';
export type { CameraOptions } from './browser/camera.js';

export {
  loadModels,
  releaseModels,
  fetchModel,
  isCrossOriginIsolated,
  hasWebGPU,
  getGPUAdapterInfo,
  getExecutionProviders,
} from './browser/models.js';
export type {
  ModelUrls,
  ModelSlot,
  LoadOptions,
  LoadedModels,
  OrtLike,
} from './browser/models.js';

export { VigiloBrowser } from './browser/runtime.js';
export type {
  RuntimeOptions,
  FrameOutcome,
  Latencies,
  FrameListener,
} from './browser/runtime.js';

import { vigilo } from './wasm.js';
import type { BBox, Config, Event, Signals } from './types.js';

/**
 * Replay recorded `Signals` through the fusion engine.
 *
 * Deterministic: the same input replays to a byte-identical event sequence
 * every time, which is what makes threshold tuning possible at all. Tuning
 * that requires re-running models does not get done.
 */
export function replay(signals: Signals[] | string, config?: Config | string): Event[] {
  const signalsJson = typeof signals === 'string' ? signals : JSON.stringify(signals);
  const configStr = typeof config === 'object' ? JSON.stringify(config) : config;
  return JSON.parse(vigilo().replay_signals(signalsJson, configStr));
}

/** Intersection-over-Union of two boxes. */
export function iou(boxA: BBox, boxB: BBox): number {
  return vigilo().calculate_iou(boxA, boxB);
}

/**
 * Greedy non-maximum suppression, within each class.
 *
 * Generic in the candidate type: the suppressor only reads `class_id`, `bbox`
 * and `score`, and returns the surviving objects unchanged, so whatever else
 * you hung off them comes back with them.
 */
export function nms<T extends { class_id: number; bbox: BBox; score: number }>(
  candidates: T[],
  iouThreshold = 0.45,
  topK = 100
): T[] {
  return vigilo().non_max_suppression(candidates, iouThreshold, topK) as T[];
}

/** The engine defaults, with every field filled in. */
export function getDefaultConfig(): Config {
  return vigilo().get_default_config() as Config;
}

/** Validate a config JSON string. Throws with the reason if it is not valid. */
export function validateConfig(configJson: string): boolean {
  return vigilo().validate_config(configJson);
}
