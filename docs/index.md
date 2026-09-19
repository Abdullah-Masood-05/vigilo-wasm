---
layout: home

hero:
  name: "Vigilo WASM"
  text: "In-browser AI exam proctoring"
  tagline: "YuNet face detection, head pose, gaze, prohibited objects, and temporal fusion engine compiled to WebAssembly with WebGPU acceleration."
  image:
    src: /logo.svg
    alt: Vigilo WASM Logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Browser API reference
      link: /api/vigilo-browser
    - theme: alt
      text: GitHub
      link: https://github.com/Abdullah-Masood-05/vigilo-wasm

features:
  - icon: 🛡️
    title: 100% In-Browser Privacy
    details: Camera frames never leave the client machine. No video streaming to servers, no media uploads, and zero cloud processing costs.
  - icon: ⚡
    title: Rust & WebAssembly Core
    details: Letterboxing, NCHW packing, anchor decoding, non-max suppression, and temporal hysteresis run directly in WebAssembly compiled with --target web.
  - icon: 🚀
    title: WebGPU & SIMD Acceleration
    details: Leverages onnxruntime-web with WebGPU or multi-threaded WASM SIMD for near-native neural inference latency directly in a browser tab.
  - icon: 👁
    title: Multi-Model Vision Suite
    details: Integrated pipelines for YuNet face detection (640x640), MobileNetV3 head pose (224x224), MobileOne-S0 gaze tracking (448x448), and YOLOX-Nano objects (416x416).
  - icon: ⏱
    title: Deterministic Temporal Fusion
    details: State-machine hysteresis, hold timers, and score accumulators turn noisy frame predictions into rock-solid violation events that replay byte-identically.
  - icon: 📦
    title: Zero Bundler Requirement
    details: "Native ES modules and --target web WASM binaries work out of the box with a plain &lt;script type=module&gt; tag, Vite, Next.js, or Bun."
---

<div class="vp-doc" style="max-width: 960px; margin: 40px auto 0;">

## Quick installation

::: code-group
```bash [npm]
npm install vigilo-wasm
```

```bash [bun]
bun add vigilo-wasm
```

```bash [pnpm]
pnpm add vigilo-wasm
```

```bash [yarn]
yarn add vigilo-wasm
```
:::

## Example: In-browser live exam proctoring

```ts
import { initVigilo, CameraSource, loadModels, VigiloBrowser } from 'vigilo-wasm';

// 1. Initialize WebAssembly module (idempotent)
await initVigilo();

// 2. Open camera (ideal 1280x720, unbuffered drop-not-queue)
const camera = await CameraSource.open();

// 3. Load ONNX models (cached automatically in Cache API)
const models = await loadModels({
  face:    '/models/face_detection_yunet_2023mar.onnx',
  pose:    '/models/headpose_mobilenetv3_small.onnx',
  gaze:    '/models/mobileone_s0_gaze.onnx',
  objects: '/models/yolox_nano.onnx',
}, {
  executionProviders: ['webgpu', 'wasm'],
});

// 4. Create browser runtime and listen for events
const vigilo = await VigiloBrowser.create({
  camera,
  models,
  faceHz: 10,     // 10 Hz face pacing
  objectHz: 1,    // 1 Hz background object scan
  gazeEvery: 2,   // Gaze evaluation every 2nd face frame
});

vigilo.onViolationStarted((v) => {
  console.warn(`[VIOLATION START] ${v.kind}: ${v.subject ?? ''} (confidence: ${v.confidence})`);
});

vigilo.onViolationEnded((v) => {
  console.info(`[VIOLATION END] ${v.kind} lasted ${v.t_end_ms! - v.t_start_ms}ms`);
});

vigilo.onFrame(({ signals, active, total_ms, stages }) => {
  // Draw bounding boxes, 3D pose gizmos, gaze rays, and violation pills
  drawHud(signals, active, stages);
});

// Start detection loop
vigilo.start();

// Later when exam finishes, resolve remaining open violations:
// const finalEvents = vigilo.finish();
```

</div>
