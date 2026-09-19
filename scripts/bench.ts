/**
 * Which model file and how many threads. Both answers were surprising.
 *
 * Run with `bun run scripts/bench.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = pathToFileURL(resolve('node_modules/onnxruntime-web/dist') + '/').href;

const CASES = [
  { name: 'yunet int8', path: 'demo/models/face_detection_yunet_2023mar_int8.onnx', dims: [1, 3, 640, 640] },
  { name: 'yunet fp32', path: 'demo/models/face_detection_yunet_2023mar.onnx', dims: [1, 3, 640, 640] },
  { name: 'headpose  ', path: 'demo/models/headpose_mobilenetv3_small.onnx', dims: [1, 3, 224, 224] },
  { name: 'gaze      ', path: 'demo/models/mobileone_s0_gaze.onnx', dims: [1, 3, 448, 448] },
  { name: 'yolox     ', path: 'demo/models/yolox_nano.onnx', dims: [1, 3, 416, 416] },
];

for (const threads of [1, 4]) {
  ort.env.wasm.numThreads = threads;
  console.log(`\n--- ${threads} thread${threads > 1 ? 's' : ''} ---`);

  for (const { name, path, dims } of CASES) {
    let session;
    try {
      session = await ort.InferenceSession.create(readFileSync(path), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      console.log(`${name}  unavailable (${String(e).slice(0, 60)})`);
      continue;
    }

    const input = new Float32Array(dims.reduce((a, b) => a * b, 1));
    const feed = { [session.inputNames[0]]: new ort.Tensor('float32', input, dims) };

    await session.run(feed); // warm
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      await session.run(feed);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    console.log(`${name}  p50 ${samples[3].toFixed(0).padStart(4)} ms   min ${samples[0].toFixed(0).padStart(4)} ms`);
    await session.release();
  }
}
