# vigilo-wasm-gpu

[![Documentation](https://img.shields.io/badge/docs-vigilo--wasm-orange?logo=vitepress)](https://abdullah-masood-05.github.io/vigilo-wasm/)
[![npm version](https://img.shields.io/npm/v/vigilo-wasm-gpu.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/vigilo-wasm-gpu)
[![WebGPU](https://img.shields.io/badge/WebGPU-hardware--accelerated-00C7B7?logo=webgpu&logoColor=white)](https://onnxruntime.ai/docs/tutorials/web/webgpu-setup.html)
[![Rust](https://img.shields.io/badge/Rust-1.80+-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-wasm--bindgen-654FF0?logo=webassembly&logoColor=white)](https://rustwasm.github.io/wasm-bindgen/)
[![ONNX Runtime Web](https://img.shields.io/badge/onnxruntime--web-1.30-005CED?logo=onnx&logoColor=white)](https://onnxruntime.ai/docs/tutorials/web/)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)

**GPU-accelerated exam proctoring that runs entirely in a browser tab.** Face detection, head
pose, gaze, prohibited objects and the full temporal fusion engine — powered by **WebGPU** for hardware acceleration, with automatic fallback to WebAssembly SIMD. No server, no upload, no native app. Camera frames never leave the machine.

> **GPU Branch (`gpu`)**: This branch contains the GPU-optimized build of `vigilo-wasm`. Inference sessions prioritize WebGPU (`['webgpu', 'wasm']`), offloading heavy convolutions (especially 448×448 gaze estimation) to client GPUs for a 5–10× speedup.

📖 **[Documentation Website](https://abdullah-masood-05.github.io/vigilo-wasm/)** — guides, architecture, benchmarks, and full API reference.

This is [`vigilo-core`](../deepscreen-detect) ported to the web. The Rust
engine is the same code, compiled to WebAssembly; only inference and capture
were replaced.

---

## What runs where

```
┌─ browser tab ──────────────────────────────────────────────┐
│                                                            │
│  getUserMedia ──► canvas ──► RGBA bytes                    │
│                                 │                          │
│                                 ▼                          │
│                    ┌────────────────────────┐              │
│                    │  vigilo-wasm (Rust)    │              │
│                    │  letterbox, crop,      │              │
│                    │  NCHW pack             │              │
│                    └───────────┬────────────┘              │
│                                │ Float32Array              │
│                                ▼                           │
│                    ┌────────────────────────┐              │
│                    │  onnxruntime-web       │              │
│                    │  wasm SIMD / WebGPU    │              │
│                    └───────────┬────────────┘              │
│                                │ raw output tensors        │
│                                ▼                           │
│                    ┌────────────────────────┐              │
│                    │  vigilo-wasm (Rust)    │              │
│                    │  anchor decode, NMS,   │              │
│                    │  Signals, FusionEngine │              │
│                    └───────────┬────────────┘              │
│                                │                           │
│                                ▼  Violation events         │
└────────────────────────────────────────────────────────────┘
```

Everything that is not a matrix multiply stays in Rust: which face is the
primary one, whether gaze is allowed to run, what an absent signal means, and
what all of it adds up to over time. That is the point of the split —
reimplementing any of it in TypeScript would create a second copy of rules that
are tuned against a recorded corpus, and the two would drift the first time one
was fixed.

## Models

| Slot | Model | Input | Size | Warm latency |
|---|---|---|---|---|
| Face | YuNet 2023mar | 640×640 BGR | 232 KB | **51 ms** |
| Head pose | MobileNetV3-Small | 224×224 RGB | 5.8 MB | **13 ms** |
| Gaze | MobileOne-S0 (L2CS) | 448×448 RGB | 4.7 MB | **104 ms** |
| Objects | YOLOX-Nano | 416×416 BGR | 3.5 MB | **75 ms** |

Measured warm, single-threaded `wasm` execution provider — `bun run bench`.
14 MB of models total, cached in the Cache API after the first load.

**Identity (ArcFace) was dropped.** 13.6 MB — as much as the other four
together — for a 0.2 Hz signal that needs an enrolled reference photo a browser
tab has no trustworthy way to obtain. The `identity` slot reports
`not_configured` for the whole session, which is the value that tells fusion
"never available" rather than "absent right now".

### Two measurements worth knowing

**Use the float YuNet, not the int8 one.** The quantized file is less than half
the download and four times the latency — 209 ms against 51 ms — because
ORT-web's wasm backend has no fast quantized-convolution kernel. That ratio is
a property of this runtime, not of the model.

**Gaze is the budget.** At 448×448 it costs more than the face and pose models
combined. `gazeEvery: 2` is the default for that reason and is the first knob
to turn when frames are slow.

## Quick start

```bash
bun install
bun run build          # wasm-pack --target web, then tsc
bun run models         # copy .onnx files out of the vigilo-core checkout
bun run demo           # http://localhost:5321
```

```ts
import { initVigilo, CameraSource, loadModels, VigiloBrowser } from 'vigilo-wasm';

await initVigilo();

const camera = await CameraSource.open();
const models = await loadModels({
  face:    '/models/face_detection_yunet_2023mar.onnx',
  pose:    '/models/headpose_mobilenetv3_small.onnx',
  gaze:    '/models/mobileone_s0_gaze.onnx',
  objects: '/models/yolox_nano.onnx',
});

const vigilo = await VigiloBrowser.create({ camera, models });

vigilo.onViolationStarted((v) => console.warn(v.kind, v.subject));
vigilo.onFrame(({ signals, active }) => draw(signals, active));
vigilo.start();

// Later, so violations still open get their end events:
vigilo.finish();
```

### WebGPU

One option, and the gaze model is where it pays:

```ts
await loadModels(urls, { executionProviders: ['webgpu', 'wasm'] });
```

## Requirements

- **A secure context.** `getUserMedia` needs `https://` or `localhost`.
- **COOP + COEP**, if you want multi-threaded wasm. `SharedArrayBuffer` is
  gated on cross-origin isolation; `isCrossOriginIsolated()` tells you whether
  you have it. The bundled dev server sets both headers.
- **A bundler is *not* required.** The package ships a `--target web` wasm
  build and hands `onnxruntime-web` in as an argument, so a plain
  `<script type="module">` page works. The demo is exactly that.

## Lower-level API

`VigiloBrowser` is a scheduler over `VigiloPipeline`, which is exposed
directly if you want to drive inference yourself — a different runtime, a Web
Worker, a recorded video file:

```ts
pipeline.beginFrame(rgba, width, height);

const faceTensor = pipeline.faceInput();        // Float32Array [1,3,640,640]
const outputs = await yourSession.run(...);
const bag = new TensorBag();
for (const [name, t] of Object.entries(outputs)) bag.set(name, t.data);
pipeline.decodeFace(bag);

if (pipeline.faceCount() > 0 && pipeline.gazeGate() === null) {
  /* ... */
}

const { signals, events, active } = pipeline.endFrame(tMs);
```

`tMs` is **milliseconds since session start**, and it is a parameter rather
than a clock read on purpose: fusion is a pure function of its inputs and
discrete time, so the same frames replay to a byte-identical event sequence
every time. That is what makes threshold tuning possible against a recorded
corpus.

### Fusion only

To run the decision engine over signals you produced some other way:

```ts
import { ProctorSession, replay } from 'vigilo-wasm';

const session = new ProctorSession();
session.step(signals, tMs);

const events = replay(recordedSignals);   // deterministic
```

## Known limits

- **Background tabs are throttled.** A hidden tab has its timers clamped to
  roughly 1 Hz and there is no way to opt out. The runtime watches
  `visibilitychange` and emits a `degraded` event so the gap shows up in the
  session record as a period the system could not see, rather than as a stretch
  of clean frames. Silence must never read as innocence.
- **Everything is on the main thread.** A YOLOX tick is ~75 ms of jank once a
  second. Moving the loop into a Web Worker is the fix and is not done yet.
- **No identity verification.** See above.
- **No calibration step.** The pose model is an absolute regressor, so it needs
  none; the gaze thresholds inherit the native defaults untouched.

## Development

```bash
cargo test             # 60 Rust tests: preprocessing, decoding, fusion
bun test               # 33 TS tests, incl. the real ONNX graphs
bun run typecheck
bun run bench          # per-model latency by execution provider
```

The integration suite loads the actual `.onnx` files and checks every tensor
name and shape the decoder assumes against what the graphs really declare —
`onnxruntime-web` runs under Bun on the same wasm backend a browser uses, so
that is the browser path minus the camera.

## Licence

GNU Affero General Public License v3.0 (`AGPL-3.0-only`). Note that serving
this to browsers is conveyance over a network, so the source obligation applies
to the frontend that embeds it.
