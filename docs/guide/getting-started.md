# Installation & Quickstart

Get started with **vigilo-wasm** in your web application.

---

## 1. Choosing Your Package: CPU vs GPU

Vigilo is maintained across two builds tailored for different client constraints:

| Package | Branch | Primary Target | Acceleration Backend |
|---|---|---|---|
| **`vigilo-wasm`** | `main` | Standard web, headless runtimes, CPU-only nodes | Multi-threaded WASM SIMD |
| **`vigilo-wasm-gpu`** | `gpu` | High-performance client browsers | **WebGPU** (hardware GPU) with WASM fallback |

### Installation

Install your preferred package alongside `onnxruntime-web`:

::: code-group
```bash [CPU Build (vigilo-wasm)]
# Recommended for standard web apps and compatibility
bun add vigilo-wasm onnxruntime-web@^1.20.0
# Or npm:
npm install vigilo-wasm onnxruntime-web@^1.20.0
```

```bash [GPU Build (vigilo-wasm-gpu)]
# Recommended for maximum framerates via WebGPU
bun add vigilo-wasm-gpu onnxruntime-web@^1.20.0
# Or npm:
npm install vigilo-wasm-gpu onnxruntime-web@^1.20.0
```
:::

> [!NOTE]
> `onnxruntime-web` is declared as an optional peer dependency. You can import it via your bundler, or provide a CDN-loaded global instance directly to `VigiloBrowser`. Both packages export the same unified TypeScript API.

---

## 2. Serving Model Files & WASM

Vigilo WASM requires:
1. The WebAssembly binary: `vigilo_wasm_bg.wasm` (shipped in the package under `pkg/`).
2. The four ONNX model files:
   - `face_detection_yunet_2023mar.onnx` (~232 KB)
   - `headpose_mobilenetv3_small.onnx` (~5.8 MB)
   - `mobileone_s0_gaze.onnx` (~4.7 MB)
   - `yolox_nano.onnx` (~3.5 MB)

You should place these `.onnx` models in your web server's public assets folder (e.g. `/public/models/`).

### Downloading Model Weights

You can obtain the validated ONNX models directly from the [vigilo-wasm GitHub repository](https://github.com/Abdullah-Masood-05/vigilo-wasm/tree/main/models) or copy them via the built-in script:

```bash
bun run models
```

---

## 3. Quickstart Example

Here is a complete example initializing the engine, streaming from the webcam, and handling proctoring violations:

```ts
import {
  initVigilo,
  CameraSource,
  loadModels,
  VigiloBrowser,
  type FrameOutcome,
  type Violation,
} from 'vigilo-wasm';

async function startProctoring() {
  // 1. Initialize WebAssembly module
  // Idempotent: can be safely awaited across multiple components
  await initVigilo();

  // 2. Open camera (defaults to 1280x720 selfie camera)
  const camera = await CameraSource.open({
    width: 1280,
    height: 720,
    facingMode: 'user',
  });

  // 3. Load ONNX models with WebGPU acceleration (falls back to WASM)
  const models = await loadModels({
    face:    '/models/face_detection_yunet_2023mar.onnx',
    pose:    '/models/headpose_mobilenetv3_small.onnx',
    gaze:    '/models/mobileone_s0_gaze.onnx',
    objects: '/models/yolox_nano.onnx',
  }, {
    executionProviders: ['webgpu', 'wasm'],
    cache: true, // Cache models in Cache API for instant reload
  });

  // 4. Create the VigiloBrowser instance
  const vigilo = await VigiloBrowser.create({
    camera,
    models,
    faceHz: 10,     // 10 Hz target for face detection & head pose
    objectHz: 1,    // 1 Hz target for object detection
    gazeEvery: 2,   // Run gaze model on every 2nd face frame
  });

  // 5. Subscribe to violation events
  vigilo.onViolationStarted((violation: Violation) => {
    console.warn(`[VIOLATION START] ${violation.kind} (severity: ${violation.severity})`, {
      confidence: violation.confidence,
      subject: violation.subject,
      evidence: violation.evidence,
    });
  });

  vigilo.onViolationEnded((violation: Violation) => {
    console.info(`[VIOLATION END] ${violation.kind} concluded.`);
  });

  // 6. Subscribe to per-frame signals and latencies for HUD rendering
  vigilo.onFrame((outcome: FrameOutcome) => {
    const { signals, active, total_ms, stages } = outcome;
    console.debug(`Frame latency: ${total_ms.toFixed(1)}ms | Active:`, active);
  });

  // 7. Start the detection loop
  vigilo.start();

  // Return a cleanup handle
  return () => {
    const finalEvents = vigilo.finish();
    camera.close();
    return finalEvents;
  };
}
```

---

## 4. Vanilla Script Tag (No Bundler)

`vigilo-wasm` is built with `--target web`. It does not require Webpack, Vite, or any build step to run in modern browsers:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Vigilo WASM Vanilla Demo</title>
</head>
<body>
  <video id="preview" autoplay muted playsinline width="640" height="360"></video>

  <!-- Import map for CDN resolution -->
  <script type="importmap">
    {
      "imports": {
        "onnxruntime-web": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.min.js",
        "vigilo-wasm": "/dist/index.js"
      }
    }
  </script>

  <script type="module">
    import * as ort from 'onnxruntime-web';
    import { initVigilo, CameraSource, loadModels, VigiloBrowser } from 'vigilo-wasm';

    await initVigilo('/pkg/vigilo_wasm_bg.wasm');

    const video = document.getElementById('preview');
    const camera = await CameraSource.open({ video });

    const models = await loadModels({
      face: '/models/face_detection_yunet_2023mar.onnx',
      pose: '/models/headpose_mobilenetv3_small.onnx',
    }, { ort });

    const vigilo = await VigiloBrowser.create({ camera, models, ort });
    vigilo.onViolationStarted(v => alert(`Violation: ${v.kind}`));
    vigilo.start();
  </script>
</body>
</html>
```
