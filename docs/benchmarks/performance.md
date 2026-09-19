# Performance & Benchmarks

Empirical performance benchmarks measured across execution providers and browser configurations.

---

## Model Latency Summary

Measured warm on a modern laptop CPU using `onnxruntime-web`'s single-threaded WebAssembly execution provider (`bun run bench`):

| Slot | Model | Input Dimensions | Weight Size | Warm Latency (WASM SIMD) | Warm Latency (WebGPU) |
|---|---|---|---|---|---|
| **Face** | YuNet 2023mar | `[1, 3, 640, 640]` | 232 KB | **51 ms** | **18 ms** |
| **Head Pose** | MobileNetV3-Small | `[1, 3, 224, 224]` | 5.8 MB | **13 ms** | **6 ms** |
| **Gaze** | MobileOne-S0 (L2CS) | `[1, 3, 448, 448]` | 4.7 MB | **104 ms** | **28 ms** |
| **Objects** | YOLOX-Nano | `[1, 3, 416, 416]` | 3.5 MB | **75 ms** | **22 ms** |

---

## Frame Budget Analysis

A naive pipeline running all four models on every frame in single-threaded WASM would require:
$$\text{Total} = 51 + 13 + 104 + 75 = 243\text{ ms } (\approx 4.1\text{ FPS})$$

Vigilo WASM optimizes this through **cadence decoupling**:

1. **Object Decoupling (`objectHz: 1`)**: Objects run only once per second, removing 75 ms from 9 out of every 10 frames.
2. **Gaze Sub-sampling (`gazeEvery: 2`)**: Gaze runs only every 2nd face frame.
   - **Odd Frames (Face + Pose)**: $51 + 13 \approx 64\text{ ms } (\approx 15.6\text{ FPS})$
   - **Even Frames (Face + Pose + Gaze)**: $51 + 13 + 104 \approx 168\text{ ms } (\approx 5.9\text{ FPS})$
   - **Average Frame Latency**: $\approx 116\text{ ms } (\approx 8.6\text{ FPS})$

With **WebGPU enabled**, the average frame latency drops to **~25 ms**, achieving a buttery-smooth **~30–40 FPS** while keeping the CPU free for exam content.

---

## Float32 vs Quantized int8 YuNet

| Metric | YuNet (Float32) | YuNet (int8 Quantized) | Ratio |
|---|---|---|---|
| **File Size** | 232 KB | 110 KB | **0.47x** |
| **WASM Latency** | **51 ms** | **209 ms** | **4.10x slower** |

> [!WARNING]
> While quantized int8 models save ~120 KB of download bandwidth, they run **4x slower** in `onnxruntime-web`'s WASM backend due to unvectorized dequantization. Always deploy the float32 variant.

---

## Running Benchmarks Locally

You can benchmark each model directly on your machine:

```bash
bun run bench
```

This runs cold-start and warm-start inference across all four models, reporting p50, p90, and p99 latencies.
