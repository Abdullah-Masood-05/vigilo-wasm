/**
 * Getting the four ONNX graphs into the browser and onto an execution provider.
 *
 * `onnxruntime-web` is a **peer** dependency, loaded dynamically and
 * overridable. That is what keeps this package usable without a bundler: a
 * plain `<script type="module">` page can hand in the ESM build it already
 * fetched from a CDN, and nothing here tries to resolve a bare specifier.
 *
 * # ArcFace is not here
 *
 * Four models, not five. The identity embedding is 13.6 MB — as much as the
 * other four together — for a signal that runs at 0.2 Hz and needs an enrolled
 * reference photo the browser has no trustworthy way to obtain. It was dropped
 * deliberately, not forgotten; the pipeline reports `identity` as
 * `not_configured` for the whole session.
 */

import type { InferenceSession, Tensor, env as OrtEnv } from 'onnxruntime-web';

/** The slice of the `onnxruntime-web` namespace this module actually uses. */
export interface OrtLike {
  InferenceSession: {
    create(
      buffer: ArrayBufferLike | Uint8Array,
      options?: InferenceSession.SessionOptions
    ): Promise<InferenceSession>;
  };
  Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims: readonly number[]
  ) => Tensor;
  env: typeof OrtEnv;
}

export type ModelSlot = 'face' | 'pose' | 'gaze' | 'objects';

export interface ModelUrls {
  /** YuNet. The only one that is not optional — everything downstream crops
   *  from its boxes. */
  face: string;
  /** MobileNetV3-Small head pose. */
  pose?: string;
  /** MobileOne-S0 gaze. The heaviest of the four at 448x448. */
  gaze?: string;
  /** YOLOX-Nano prohibited objects. */
  objects?: string;
}

export interface LoadOptions {
  /**
   * The `onnxruntime-web` namespace. Omit to dynamically import
   * `onnxruntime-web/webgpu` or `onnxruntime-web`.
   */
  ort?: OrtLike;
  /**
   * Execution providers, in preference order.
   *
   * On this GPU build, defaults to `['webgpu', 'wasm']`:
   * WebGPU moves heavy convolutional models (especially the 448x448 gaze model)
   * to the GPU, dropping per-frame latency by 5–10x on supported hardware.
   * If WebGPU is not supported by the client browser, it automatically falls back
   * to wasm SIMD.
   */
  executionProviders?: string[];
  /**
   * Explicit GPU toggle:
   * - `true`: Prioritizes WebGPU (`['webgpu', 'wasm']`).
   * - `false`: Disables GPU and runs pure CPU (`['wasm']`).
   * - `'auto'` (default on GPU build): Automatically uses WebGPU when available.
   */
  gpu?: boolean | 'auto';
  /** Where ORT's own `.wasm` binaries live. Needed on a page with no bundler. */
  wasmPaths?: string;
  /**
   * Threads for the wasm provider fallback. More than 1 requires the page to be
   * cross-origin isolated (COOP + COEP headers), because `SharedArrayBuffer`
   * is gated on it. Defaults to hardware concurrency when isolated, 1 when
   * not — asking for threads without the headers fails at session creation.
   */
  numThreads?: number;
  /** Cache downloaded `.onnx` files in the Cache API. */
  cache?: boolean;
  onProgress?: (slot: ModelSlot, loaded: number, total: number) => void;
}

export interface LoadedModels {
  face: InferenceSession;
  pose?: InferenceSession;
  gaze?: InferenceSession;
  objects?: InferenceSession;
  /** Active execution provider priority configured for these models. */
  executionProviders: string[];
  /** Slots whose download or session creation failed, and why. */
  failed: Array<{ slot: ModelSlot; error: string }>;
}

const CACHE_NAME = 'vigilo-models-v1';

interface WebGpuNavigator {
  gpu?: {
    requestAdapter: (options?: unknown) => Promise<{
      requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; description?: string }>;
    } | null>;
  };
}

/**
 * Detect whether WebGPU acceleration is supported and available in the current browser.
 */
export async function hasWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const nav = navigator as unknown as WebGpuNavigator;
  if (!nav.gpu) {
    return false;
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Inspect active GPU hardware adapter info (vendor, architecture, driver).
 */
export async function getGPUAdapterInfo(): Promise<{ vendor?: string; architecture?: string; description?: string } | null> {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const nav = navigator as unknown as WebGpuNavigator;
  if (!nav.gpu) {
    return null;
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return null;
    const info = (await adapter.requestAdapterInfo?.()) || {};
    return {
      vendor: info.vendor || '',
      architecture: info.architecture || '',
      description: info.description || '',
    };
  } catch {
    return null;
  }
}

/**
 * Returns the recommended execution providers for this environment.
 * On this GPU build, returns `['webgpu', 'wasm']` when GPU is preferred and supported.
 */
export async function getExecutionProviders(preferGpu = true): Promise<string[]> {
  if (preferGpu && (await hasWebGPU())) {
    return ['webgpu', 'wasm'];
  }
  return ['wasm'];
}

/**
 * Whether this page can use more than one wasm thread.
 *
 * Worth checking explicitly rather than just trying: without COOP/COEP the
 * failure is a `SharedArrayBuffer is not defined` from inside ORT's glue,
 * which reads like a browser support problem rather than a missing response
 * header on your own server.
 */
export function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : false;
}

/** Fetch an `.onnx` file, from the Cache API when it is already there. */
export async function fetchModel(
  url: string,
  slot: ModelSlot,
  options: Pick<LoadOptions, 'cache' | 'onProgress'> = {}
): Promise<Uint8Array> {
  const useCache = options.cache !== false && typeof caches !== 'undefined';

  if (useCache) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch {
      // A private window, a disabled storage API, or a quota error. Falling
      // through to a plain fetch costs a download, not a session.
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${slot} model: HTTP ${response.status} for ${url}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const bytes = options.onProgress
    ? await readWithProgress(response, slot, total, options.onProgress)
    : new Uint8Array(await response.clone().arrayBuffer());

  if (useCache) {
    try {
      const cache = await caches.open(CACHE_NAME);
      // `bytes as BodyInit`: a `Uint8Array` is a perfectly good body, but its
      // type parameter is `ArrayBufferLike`, which TypeScript will not narrow
      // to the `ArrayBuffer` that `BodyInit` wants.
      await cache.put(url, new Response(bytes as BodyInit, { headers: response.headers }));
    } catch {
      // Over quota. The model is loaded either way; only the next reload pays.
    }
  }
  return bytes;
}

async function readWithProgress(
  response: Response,
  slot: ModelSlot,
  total: number,
  onProgress: NonNullable<LoadOptions['onProgress']>
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(slot, loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Download and instantiate every configured model.
 *
 * Degrade, never die: if `pose`, `gaze` or `objects` fails, its slot is
 * reported in `failed` and the session runs without it — a proctoring run with
 * no object detector is worth more than no run at all. A failed **face** model
 * does throw, because nothing downstream of it has anything to crop from.
 */
export async function loadModels(
  urls: ModelUrls,
  options: LoadOptions = {}
): Promise<LoadedModels> {
  // On this GPU build, default execution provider priority is WebGPU first, then wasm fallback
  let executionProviders = options.executionProviders;
  if (!executionProviders) {
    if (options.gpu === false) {
      executionProviders = ['wasm'];
    } else {
      executionProviders = ['webgpu', 'wasm'];
    }
  }

  let ort = options.ort;
  if (!ort) {
    if (executionProviders.includes('webgpu')) {
      try {
        // Prefer WebGPU entry point when targeting GPU
        // @ts-ignore
        ort = ((await import('onnxruntime-web/webgpu')) as unknown as OrtLike);
      } catch {
        ort = ((await import('onnxruntime-web')) as unknown as OrtLike);
      }
    } else {
      ort = ((await import('onnxruntime-web')) as unknown as OrtLike);
    }
  }

  if (options.wasmPaths) {
    ort.env.wasm.wasmPaths = options.wasmPaths;
  }
  ort.env.wasm.numThreads =
    options.numThreads ??
    (isCrossOriginIsolated() ? Math.min(4, navigator.hardwareConcurrency || 1) : 1);

  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders: executionProviders as never,
    graphOptimizationLevel: 'all',
  };

  const create = async (slot: ModelSlot, url: string) => {
    const bytes = await fetchModel(url, slot, options);
    return ort.InferenceSession.create(bytes, sessionOptions);
  };

  // The face model is awaited on its own so its failure is a thrown error
  // rather than an entry in `failed`.
  const face = await create('face', urls.face);

  const optional: ModelSlot[] = ['pose', 'gaze', 'objects'];
  const failed: LoadedModels['failed'] = [];
  const sessions: Partial<Record<ModelSlot, InferenceSession>> = {};

  const settled = await Promise.allSettled(
    optional.map(async (slot) => {
      const url = urls[slot];
      if (!url) return null;
      return { slot, session: await create(slot, url) };
    })
  );

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      if (result.value) sessions[result.value.slot] = result.value.session;
    } else {
      failed.push({ slot: optional[i], error: String(result.reason) });
    }
  });

  return { face, ...sessions, executionProviders, failed };
}

/** Free every session. Sessions hold wasm memory that GC will not reclaim. */
export async function releaseModels(models: LoadedModels): Promise<void> {
  const sessions = [models.face, models.pose, models.gaze, models.objects];
  await Promise.all(
    sessions.map(async (s) => {
      try {
        await s?.release();
      } catch {
        // Already released, or the runtime is tearing down. Nothing to do.
      }
    })
  );
}
