export * from './types.js';
export * from './session.js';

// Re-export WASM raw bindings
export type {
  WasmFusionEngine,
  WasmDirectionTracker,
} from '../pkg/vigilo_wasm.js';

import * as wasm from '../pkg/vigilo_wasm.js';
export { wasm };

import { ProctorSession } from './session.js';
import type { Config } from './types.js';

/**
 * Convenience factory to create an initialized ProctorSession.
 */
export function createProctorSession(config?: Config | string): ProctorSession {
  return new ProctorSession(wasm, config);
}

/**
 * Replay an array or JSON string of Signals deterministically through the fusion engine.
 */
export function replay(signals: any[] | string, config?: Config | string): any[] {
  const signalsJson = typeof signals === 'string' ? signals : JSON.stringify(signals);
  const configStr = typeof config === 'object' ? JSON.stringify(config) : config;
  const resultJson = wasm.replay_signals(signalsJson, configStr);
  return JSON.parse(resultJson);
}

/**
 * Fast BBox Intersection-over-Union in WebAssembly.
 */
export function iou(boxA: any, boxB: any): number {
  return wasm.calculate_iou(boxA, boxB);
}

/**
 * Fast Non-Maximum Suppression in WebAssembly.
 */
export function nms(candidates: any[], iouThreshold = 0.45, topK = 100): any[] {
  return wasm.non_max_suppression(candidates, iouThreshold, topK);
}

/**
 * Retrieve the default engine configuration.
 */
export function getDefaultConfig(): Config {
  return wasm.get_default_config();
}

/**
 * Validate a configuration JSON string.
 */
export function validateConfig(configJson: string): boolean {
  return wasm.validate_config(configJson);
}
