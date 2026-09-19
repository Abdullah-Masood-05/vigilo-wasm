# VigiloPipeline (Lower-Level API)

The lower-level WebAssembly pipeline struct for callers who wish to drive neural inference manually—such as inside a Web Worker, offscreen rendering context, or custom video decoder.

```ts
import { vigilo, type VigiloWasm } from 'vigilo-wasm';

const { VigiloPipeline, TensorBag } = vigilo();
```

---

## Manual Inference Loop

If you don't use `VigiloBrowser`, you can interact with `VigiloPipeline` directly:

```ts
// 1. Instantiate pipeline
const pipeline = new VigiloPipeline(configJsonString);
const bag = new TensorBag();

// 2. Start a frame with RGBA buffer
pipeline.beginFrame(rgbaUint8Array, width, height);

// 3. Extract letterboxed & packed NCHW tensor for YuNet
const faceInputTensor: Float32Array = pipeline.faceInput(); // [1, 3, 640, 640]
const faceOutputs = await faceSession.run({ input: new ort.Tensor('float32', faceInputTensor, [1, 3, 640, 640]) });

// Pack outputs into TensorBag and decode
bag.clear();
for (const [name, tensor] of Object.entries(faceOutputs)) {
  bag.set(name, tensor.data as Float32Array);
}
pipeline.decodeFace(bag);

// 4. Check gaze gate before doing expensive gaze preprocessing
if (pipeline.faceCount() > 0 && pipeline.gazeGate() === null) {
  const gazeInput = pipeline.gazeInput(); // [1, 3, 448, 448]
  const gazeOutputs = await gazeSession.run({ input: new ort.Tensor('float32', gazeInput, [1, 3, 448, 448]) });
  pipeline.decodeGaze(gazeOutputs.yaw.data, gazeOutputs.pitch.data);
}

// 5. Conclude frame and obtain temporal fusion events
const result = pipeline.endFrame(tMs);
console.log(result.signals, result.events, result.active);
```

---

## `VigiloPipeline` Methods

| Method | Signature | Description |
|---|---|---|
| `beginFrame` | `(rgba: Uint8Array, width: number, height: number) => void` | Ingests a new RGBA frame and resets per-frame scratch buffers. |
| `faceInput` | `() => Float32Array` | Produces letterboxed `[1, 3, 640, 640]` BGR tensor. |
| `decodeFace` | `(bag: TensorBag) => void` | Decodes raw YuNet bounding boxes, scores, and keypoints. |
| `faceCount` | `() => number` | Number of detected faces in the current frame. |
| `gazeGate` | `() => string \| null` | Checks if gaze inference is allowed (`null` means passed; otherwise returns reason). |
| `poseInput` | `() => Float32Array` | Crops face and returns `[1, 3, 224, 224]` RGB tensor. |
| `decodePose` | `(rotation: Float32Array) => void` | Decodes 3x3 rotation matrix into yaw, pitch, roll angles. |
| `gazeInput` | `() => Float32Array` | Crops face and returns `[1, 3, 448, 448]` RGB tensor. |
| `decodeGaze` | `(yaw: Float32Array, pitch: Float32Array) => void` | Decodes gaze angles and computes eye-in-head difference. |
| `objectInput` | `() => Float32Array` | Letterboxes whole frame to `[1, 3, 416, 416]` BGR tensor. |
| `decodeObjects` | `(output: Float32Array) => void` | Decodes YOLOX detections and applies NMS. |
| `endFrame` | `(tMs: number) => FrameResult` | Runs temporal fusion and emits events. |
| `finish` | `(tMs: number) => Event[]` | Closes session and emits end events. |
| `reset` | `() => void` | Clears all temporal state. |

---

## `TensorBag`

A lightweight container passed across the WASM boundary to bundle named output tensors from `onnxruntime-web` without serializing through JSON:

```ts
const bag = new TensorBag();
bag.set('loc', locTensorData);
bag.set('conf', confTensorData);
bag.set('iou', iouTensorData);
pipeline.decodeFace(bag);
```
