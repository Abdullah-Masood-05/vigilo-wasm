# Model Loading & Caching

Vigilo WASM loads four neural models into `onnxruntime-web` sessions. This guide explains how models are fetched, cached, and scheduled across execution providers.

---

## The Four Models

| Slot | Model Name | Input Shape | Size | Warm Latency (WASM SIMD) |
|---|---|---|---|---|
| `face` | YuNet 2023mar | `[1, 3, 640, 640]` | 232 KB | **51 ms** |
| `pose` | MobileNetV3-Small | `[1, 3, 224, 224]` | 5.8 MB | **13 ms** |
| `gaze` | MobileOne-S0 (L2CS) | `[1, 3, 448, 448]` | 4.7 MB | **104 ms** |
| `objects` | YOLOX-Nano | `[1, 3, 416, 416]` | 3.5 MB | **75 ms** |

Total download footprint: **~14.2 MB**.

---

## Two Measurements Worth Knowing

### 1. Float YuNet vs Quantized int8 YuNet
You might expect a quantized int8 YuNet model to run faster than a float32 model. **On the web, the exact opposite is true:**

- **Float32 YuNet**: 232 KB, **51 ms**
- **int8 Quantized YuNet**: 110 KB, **209 ms** (4x slower!)

`onnxruntime-web`'s WebAssembly execution provider lacks optimized vector kernels for quantized convolutions on x86/ARM. It falls back to unvectorized dequantize-and-multiply routines. **Always use the float32 model.**

### 2. Gaze is the Budget
The MobileOne-S0 gaze model processes a 448×448 input tensor and accounts for over 60% of the entire pipeline compute budget. That is why `gazeEvery: 2` is the default cadence divisor.

---

## Loading Models with the Cache API

Model weights should not be redownloaded on every page load or exam refresh. `loadModels` automatically utilizes the browser's `Cache API` under the cache bucket `vigilo-models-v1`:

```ts
import { loadModels } from 'vigilo-wasm';

const models = await loadModels({
  face:    '/models/face_detection_yunet_2023mar.onnx',
  pose:    '/models/headpose_mobilenetv3_small.onnx',
  gaze:    '/models/mobileone_s0_gaze.onnx',
  objects: '/models/yolox_nano.onnx',
}, {
  cache: true, // Default: true
  onProgress: (slot, loaded, total) => {
    const pct = total > 0 ? ((loaded / total) * 100).toFixed(0) : '?';
    console.log(`Loading ${slot}: ${pct}%`);
  },
});
```

Subsequent loads fetch instantly from local disk storage without any network requests.

---

## WebGPU Hardware Acceleration

Where available, WebGPU drastically reduces neural inference latency, especially for the heavy 448×448 gaze model:

```ts
import { loadModels } from 'vigilo-wasm'; // Or 'vigilo-wasm-gpu'

const models = await loadModels(urls, {
  executionProviders: ['webgpu', 'wasm'],
});
```

### Automatic WebGPU in `vigilo-wasm-gpu`

If using the **`vigilo-wasm-gpu`** package (from the `gpu` branch), `loadModels` prioritizes `['webgpu', 'wasm']` by default:

* **Hardware GPU Active**: Models compile directly to WebGPU WGSL compute shaders on the client's GPU (NVIDIA, AMD, Intel, Apple Silicon).
* **Automatic Fallback**: If a client device or browser (e.g. older Safari or Firefox) does not support WebGPU, it seamlessly falls back to multi-threaded WASM SIMD without throwing errors or breaking the exam session.

### Detecting WebGPU in the Browser

You can detect whether the current browser session has access to a hardware GPU:

```ts
import { hasWebGPU, getGPUAdapterInfo } from 'vigilo-wasm-gpu';

if (await hasWebGPU()) {
  const adapter = await getGPUAdapterInfo();
  console.log(`WebGPU active: ${adapter?.vendor} (${adapter?.architecture})`);
} else {
  console.log('Falling back to CPU WebAssembly SIMD.');
}
```

---

## Multi-Threaded WASM & Cross-Origin Isolation

By default, `onnxruntime-web` operates in single-threaded mode. Enabling multi-threaded WASM requires `SharedArrayBuffer`, which browsers only expose in **cross-origin isolated** contexts.

Check isolation status:

```ts
import { isCrossOriginIsolated } from 'vigilo-wasm';

if (isCrossOriginIsolated()) {
  console.log('Page is cross-origin isolated. Multi-threading enabled!');
} else {
  console.warn('Single-threaded mode: serve COOP and COEP headers to unlock multi-threading.');
}
```

### Required HTTP Headers
Configure your reverse proxy (Nginx, Caddy, Cloudflare) or dev server to send:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## Handling Failed Models Gracefully

If an optional model fails to download (e.g. 404 or network timeout), `loadModels` will **not throw**. Instead, it populates `models.failed`:

```ts
const models = await loadModels({
  face: '/models/face.onnx',
  pose: '/models/broken-link.onnx',
});

if (models.failed.length > 0) {
  for (const { slot, error } of models.failed) {
    console.warn(`Model ${slot} failed to load: ${error}`);
  }
}
```

When `VigiloBrowser` starts, it automatically marks failed models as `not_configured` in the temporal fusion engine and dispatches a `degraded` event. The exam can proceed with the remaining models (e.g. face detection only).
