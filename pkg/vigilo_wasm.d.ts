/* tslint:disable */
/* eslint-disable */

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

export function init(): void;

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
 * Validate a configuration JSON string. Returns true if valid or throws an error.
 */
export function validate_config(config_json: string): boolean;
