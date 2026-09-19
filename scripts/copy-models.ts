/**
 * Copy the ONNX graphs the demo needs out of the `vigilo-core` checkout.
 *
 * The models are not committed here. They are ~15 MB of binary that already
 * lives in `deepscreen-detect/models/`, and a second copy in git would go
 * stale the first time one is re-exported — with nothing to say which of the
 * two the recorded thresholds were tuned against.
 *
 * ArcFace (`w600k_mbf.onnx`) is deliberately not in this list. See the
 * `pipeline.rs` module docs for why identity was dropped from the browser build.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dest = join(root, 'demo', 'models');

/** Override with `VIGILO_CORE=/path/to/deepscreen-detect`. */
const core = process.env.VIGILO_CORE ?? resolve(root, '..', 'deepscreen-detect');
const source = join(core, 'models');

const WANTED = [
  // The **float** face detector, not the int8 one, despite int8 being less
  // than half the download. Measured on ORT-web's wasm backend
  // (`bun run scripts/bench.ts`):
  //
  //     yunet fp32    50 ms
  //     yunet int8   209 ms
  //
  // Quantized convolution has no fast wasm kernel, so int8 costs four times
  // the latency to save 130 KB on a model that runs every single frame. The
  // int8 file is copied too, because that ratio is a property of this
  // runtime and will change — but nothing should default to it.
  'face_detection_yunet_2023mar.onnx',
  'face_detection_yunet_2023mar_int8.onnx',
  'headpose_mobilenetv3_small.onnx',
  'mobileone_s0_gaze.onnx',
  'yolox_nano.onnx',
];

if (!existsSync(source)) {
  console.error(`No models directory at ${source}`);
  console.error('Set VIGILO_CORE to your deepscreen-detect checkout.');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });

let copied = 0;
let total = 0;
for (const name of WANTED) {
  const from = join(source, name);
  if (!existsSync(from)) {
    console.warn(`  skip ${name} (not found)`);
    continue;
  }
  copyFileSync(from, join(dest, name));
  const size = statSync(from).size;
  total += size;
  copied += 1;
  console.log(`  ${name.padEnd(42)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}

console.log(`\n${copied} models, ${(total / 1024 / 1024).toFixed(1)} MB -> demo/models/`);
