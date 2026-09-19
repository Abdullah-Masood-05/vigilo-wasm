/* tslint:disable */
/* eslint-disable */

/**
 * A named bag of output tensors, so YuNet's twelve heads cross the boundary
 * in one call instead of twelve positional arguments.
 */
export class TensorBag {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    has(name: string): boolean;
    constructor();
    /**
     * Store one output tensor under the name the graph gave it.
     */
    set(name: string, data: Float32Array): void;
}

export class VigiloPipeline {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start a frame from tightly packed RGB8.
     */
    beginFrameRgb(rgb: Uint8Array, width: number, height: number): void;
    /**
     * Start a frame from `getImageData` / `VideoFrame.copyTo` output (RGBA).
     */
    beginFrame(rgba: Uint8Array, width: number, height: number): void;
    /**
     * The config in force, including every default that was filled in.
     */
    config(): any;
    /**
     * Declare which optional models the host actually loaded.
     *
     * Call once, after session creation. A model that failed to download is
     * not configured, and saying so keeps fusion from waiting on a signal
     * that is never coming.
     */
    configureSlots(pose: boolean, gaze: boolean, objects: boolean): void;
    /**
     * Decode YuNet's twelve heads into faces, sorted by score.
     *
     * Also settles what an empty result means for the two models downstream
     * of it: with no face there is nothing to crop, so pose and gaze are
     * *gated* skips rather than failures.
     */
    decodeFace(outputs: TensorBag): any;
    /**
     * Decode the two 90-bin heads, and difference against this frame's head
     * pose to get eye-in-head.
     *
     * Eye-in-head is only meaningful because both terms describe the same
     * instant, which is why pose must be decoded before gaze on a frame where
     * both run — not merely at some nearby time.
     */
    decodeGaze(yaw: Float32Array, pitch: Float32Array): any;
    /**
     * Decode and suppress the `[1, 3549, 85]` grid, keeping allowlisted
     * classes only.
     */
    decodeObjects(output: Float32Array): any;
    /**
     * Decode the `rotation_matrix` output into yaw/pitch/roll degrees.
     */
    decodePose(rotation_matrix: Float32Array): any;
    /**
     * Assemble this frame's [`Signals`], step fusion, and return both.
     *
     * `t_ms` is milliseconds since session start and must be monotonic. It is
     * a parameter rather than a clock read for the same reason it is in the
     * native engine: a recording replayed through this function must produce
     * a byte-identical event sequence, and a function that reads the clock
     * cannot promise that.
     */
    endFrame(t_ms: number): any;
    faceCount(): number;
    /**
     * YuNet input: `[1, 3, 640, 640]`, planar BGR, letterboxed top-left.
     */
    faceInput(): Float32Array;
    /**
     * Close everything still open, as a session ends.
     *
     * Without this, a violation that was open when the tab closed never gets
     * an end event and reads as zero-length in the report.
     */
    finish(t_ms: number): any;
    /**
     * Should gaze run on this frame? `null` means yes.
     *
     * Asking before preprocessing saves the 448x448 resize and the ~600 MFLOP
     * inference behind it on every frame where the answer would have been
     * noise. The side effect is recorded: a gated frame reports
     * `SkippedGated` with the reason, not a missing signal.
     */
    gazeGate(): any;
    /**
     * Gaze input: `[1, 3, 448, 448]`, planar RGB, ImageNet-normalized, over
     * the tight face box with no expansion.
     */
    gazeInput(): Float32Array;
    /**
     * Record that a slot's model errored on this frame.
     *
     * Degrade, never die: one bad inference is not a reason to end an exam,
     * but it must not be reported as a clean "nothing there" either.
     */
    markFailed(slot: string): void;
    /**
     * Build a pipeline from an optional TOML or JSON config string.
     */
    constructor(config_str?: string | null);
    /**
     * YOLOX input: `[1, 3, 416, 416]`, planar BGR, padded with 114.
     */
    objectInput(): Float32Array;
    /**
     * Head pose input: `[1, 3, 224, 224]`, planar RGB, ImageNet-normalized,
     * cropped square around the **primary** face.
     *
     * The primary face is index 0, which is the highest-scoring box because
     * NMS sorted them. With two people in shot that means pose describes the
     * candidate, not whoever wandered past behind them.
     */
    poseInput(): Float32Array;
    /**
     * Drop all temporal state. Thresholds and loaded slots are kept.
     */
    reset(): void;
}

/**
 * WebAssembly wrapper for angular head pose and gaze direction tracking.
 */
export class WasmDirectionTracker {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create a new `DirectionTracker` with optional enter/exit threshold degrees.
     */
    constructor(enter_deg?: number | null, exit_deg?: number | null);
    /**
     * Update tracking with head pose and gaze, returning direction labels.
     */
    update(head_yaw_deg?: number | null, head_pitch_deg?: number | null, gaze_yaw_rad?: number | null, gaze_pitch_rad?: number | null): any;
}

/**
 * WebAssembly wrapper for the deterministic temporal `FusionEngine`.
 */
export class WasmFusionEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Active violation kinds currently raised (deduplicated).
     */
    active(): any;
    /**
     * Active violations with subjects for live HUD detail.
     */
    active_detail(): any;
    /**
     * Finish the session at discrete time `t_ms` and close any open violations.
     */
    finish(t_ms: number): any;
    /**
     * Create a new `WasmFusionEngine` with optional TOML or JSON config string.
     * If omitted, the default config is used.
     */
    constructor(config_str?: string | null);
    /**
     * Reset the fusion engine to clean state with the current config.
     */
    reset(): void;
    /**
     * Advance the fusion engine by one frame of signals at discrete time `t_ms`.
     * Accepts a JavaScript `Signals` object and returns an array of `Event`s.
     */
    step(signals_val: any, t_ms: number): any;
    /**
     * Advance using a JSON string for signals. Returns JSON string of events.
     */
    step_json(signals_json: string, t_ms: number): string;
}

/**
 * Fast BBox Intersection-over-Union (IoU) calculation in WASM.
 */
export function calculate_iou(box_a: any, box_b: any): number;

/**
 * Returns the default system configuration as a JavaScript object.
 */
export function get_default_config(): any;

/**
 * Fast Non-Maximum Suppression (NMS) in WASM.
 * Input: Array of objects `{ class_id: number, bbox: BBox, score: number }`.
 * Returns: Array of surviving candidate objects.
 */
export function non_max_suppression(candidates_val: any, iou_threshold: number, top_k: number): any;

/**
 * Replay a batch of recorded `Signals` through the fusion engine deterministically.
 */
export function replay_signals(signals_json: string, config_str?: string | null): string;

/**
 * Runs automatically when the module is instantiated.
 *
 * Named so it cannot be confused with the loader's own `init` default export,
 * which is what a caller actually awaits.
 */
export function set_panic_hook(): void;

/**
 * Validate a configuration JSON string. Returns true if valid or throws an error.
 */
export function validate_config(config_json: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_tensorbag_free: (a: number, b: number) => void;
    readonly __wbg_vigilopipeline_free: (a: number, b: number) => void;
    readonly __wbg_wasmdirectiontracker_free: (a: number, b: number) => void;
    readonly __wbg_wasmfusionengine_free: (a: number, b: number) => void;
    readonly calculate_iou: (a: number, b: number, c: number) => void;
    readonly get_default_config: (a: number) => void;
    readonly non_max_suppression: (a: number, b: number, c: number, d: number) => void;
    readonly replay_signals: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly set_panic_hook: () => void;
    readonly tensorbag_clear: (a: number) => void;
    readonly tensorbag_has: (a: number, b: number, c: number) => number;
    readonly tensorbag_new: () => number;
    readonly tensorbag_set: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly validate_config: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_beginFrame: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vigilopipeline_beginFrameRgb: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vigilopipeline_config: (a: number, b: number) => void;
    readonly vigilopipeline_configureSlots: (a: number, b: number, c: number, d: number) => void;
    readonly vigilopipeline_decodeFace: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_decodeGaze: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vigilopipeline_decodeObjects: (a: number, b: number, c: number, d: number) => void;
    readonly vigilopipeline_decodePose: (a: number, b: number, c: number, d: number) => void;
    readonly vigilopipeline_endFrame: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_faceCount: (a: number) => number;
    readonly vigilopipeline_faceInput: (a: number, b: number) => void;
    readonly vigilopipeline_finish: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_gazeGate: (a: number, b: number) => void;
    readonly vigilopipeline_gazeInput: (a: number, b: number) => void;
    readonly vigilopipeline_markFailed: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_new: (a: number, b: number, c: number) => void;
    readonly vigilopipeline_objectInput: (a: number, b: number) => void;
    readonly vigilopipeline_poseInput: (a: number, b: number) => void;
    readonly vigilopipeline_reset: (a: number) => void;
    readonly wasmdirectiontracker_new: (a: number, b: number, c: number, d: number) => number;
    readonly wasmdirectiontracker_update: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmfusionengine_active: (a: number, b: number) => void;
    readonly wasmfusionengine_active_detail: (a: number, b: number) => void;
    readonly wasmfusionengine_finish: (a: number, b: number, c: number) => void;
    readonly wasmfusionengine_new: (a: number, b: number, c: number) => void;
    readonly wasmfusionengine_reset: (a: number) => void;
    readonly wasmfusionengine_step: (a: number, b: number, c: number, d: number) => void;
    readonly wasmfusionengine_step_json: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
