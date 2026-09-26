import { describe, it, expect } from 'bun:test';
import {
  hasWebGPU,
  getGPUAdapterInfo,
  getExecutionProviders,
} from '../ts/browser/models.js';
import { initVigilo, vigilo } from '../ts/wasm.js';

describe('WebGPU Acceleration on GPU Branch', () => {
  it('should safely report WebGPU availability without throwing in headless runtimes', async () => {
    const available = await hasWebGPU();
    expect(typeof available).toBe('boolean');
  });

  it('should return null or valid adapter info without throwing', async () => {
    const info = await getGPUAdapterInfo();
    expect(info === null || typeof info === 'object').toBe(true);
  });

  it('should provide default execution providers according to GPU availability', async () => {
    const providers = await getExecutionProviders(true);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.includes('wasm')).toBe(true);
  });

  it('should return build_target as gpu from compiled WASM module', async () => {
    await initVigilo();
    const target = vigilo().build_target();
    expect(target).toBe('gpu');
  });
});
