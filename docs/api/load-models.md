# Model Management

Utility functions for fetching, caching, and initializing `onnxruntime-web` inference sessions.

```ts
import {
  loadModels,
  fetchModel,
  releaseModels,
  isCrossOriginIsolated,
  type ModelUrls,
  type LoadOptions,
  type LoadedModels,
} from 'vigilo-wasm';
```

---

## Functions

### `loadModels(urls: ModelUrls, options?: LoadOptions): Promise<LoadedModels>`
Downloads `.onnx` model graphs (using the `Cache API` when available) and creates `InferenceSession` instances for each slot.

```ts
const models = await loadModels({
  face:    '/models/face_detection_yunet_2023mar.onnx',
  pose:    '/models/headpose_mobilenetv3_small.onnx',
  gaze:    '/models/mobileone_s0_gaze.onnx',
  objects: '/models/yolox_nano.onnx',
}, {
  executionProviders: ['webgpu', 'wasm'],
  cache: true,
  onProgress: (slot, loaded, total) => console.log(`${slot}: ${loaded}/${total}`),
});
```

#### `ModelUrls`
- `face: string` (*Required*): YuNet face detection model.
- `pose?: string` (*Optional*): MobileNetV3 head pose model.
- `gaze?: string` (*Optional*): MobileOne-S0 gaze tracking model.
- `objects?: string` (*Optional*): YOLOX-Nano prohibited object model.

#### `LoadOptions`
- `ort?: OrtLike`: `onnxruntime-web` namespace override.
- `executionProviders?: string[]`: Execution provider priority, e.g. `['webgpu', 'wasm']`.
- `wasmPaths?: string`: Path or URL where ORT's `.wasm` binaries are hosted.
- `numThreads?: number`: Thread count for WASM provider (defaults to `navigator.hardwareConcurrency` if cross-origin isolated, else 1).
- `cache?: boolean`: Whether to cache model weights in the Cache API (default `true`).
- `onProgress?: (slot: ModelSlot, loaded: number, total: number) => void`: Download progress callback.

#### `LoadedModels`
```ts
interface LoadedModels {
  face: InferenceSession;
  pose?: InferenceSession;
  gaze?: InferenceSession;
  objects?: InferenceSession;
  failed: Array<{ slot: ModelSlot; error: string }>;
}
```

---

### `fetchModel(url: string, slot: ModelSlot, options?: { cache?: boolean; onProgress?: ... }): Promise<Uint8Array>`
Fetches raw bytes of an `.onnx` model file, checking the Cache API bucket `vigilo-models-v1` first.

---

### `releaseModels(models: LoadedModels): Promise<void>`
Releases all underlying WebAssembly / WebGPU session memory in `onnxruntime-web`.

---

### `isCrossOriginIsolated(): boolean`
Returns `true` if `globalThis.crossOriginIsolated` is enabled, indicating that `SharedArrayBuffer` is available for multi-threaded WASM inference.
