/**
 * The four real ONNX graphs, against the real wasm pipeline.
 *
 * Everything else in this suite uses synthetic tensors, which cannot catch the
 * one class of bug that would break the port outright: a tensor name or shape
 * that the decoder assumes and the graph does not actually have. Those
 * assumptions were read off `detect-cli inspect` on a desktop build — this
 * test re-checks every one of them against the files that will ship.
 *
 * `onnxruntime-web` runs under Bun on the same wasm backend a browser uses, so
 * this is the browser path minus the camera and the canvas.
 *
 * Skipped when `demo/models/` is empty — the `.onnx` files are not committed.
 * Run `bun run models` first.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { VigiloPipeline, TensorBag } from '../pkg/vigilo_wasm.js';
import type { FaceDetection, FrameResult } from '../ts/types.js';

const MODELS = {
  face: 'demo/models/face_detection_yunet_2023mar.onnx',
  pose: 'demo/models/headpose_mobilenetv3_small.onnx',
  gaze: 'demo/models/mobileone_s0_gaze.onnx',
  objects: 'demo/models/yolox_nano.onnx',
};

const available = Object.values(MODELS).every((p) => existsSync(p));
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn('demo/models/*.onnx missing — run `bun run models`. Skipping integration tests.');
}

const sessions: Record<keyof typeof MODELS, ort.InferenceSession> = {} as never;
const timings: Record<string, number> = {};

const WIDTH = 1280;
const HEIGHT = 720;

/** A frame with enough structure that the detectors do real work on it. */
function frame(): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      data[i] = (x * 7 + y * 3) % 256;
      data[i + 1] = (x * 3 + y * 5) % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

async function run(
  slot: keyof typeof MODELS,
  input: Float32Array,
  dims: number[]
): Promise<Record<string, ort.Tensor>> {
  const session = sessions[slot];
  const started = performance.now();
  const outputs = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', input, dims),
  });
  timings[slot] = performance.now() - started;
  return outputs as Record<string, ort.Tensor>;
}

suite('real ONNX graphs', () => {
  beforeAll(async () => {
    ort.env.wasm.numThreads = 1;
    // Bun resolves ORT's own `.mjs` glue relative to this path, so it has to
    // be absolute. A relative one silently yields "no available backend".
    ort.env.wasm.wasmPaths = pathToFileURL(
      resolve('node_modules/onnxruntime-web/dist') + '/'
    ).href;

    for (const [slot, path] of Object.entries(MODELS)) {
      sessions[slot as keyof typeof MODELS] = await ort.InferenceSession.create(
        readFileSync(path),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      );
    }
  }, 120_000);

  it('YuNet declares the twelve heads the decoder reads by name', () => {
    // The decoder looks these up by string. A graph re-exported with different
    // names would decode to zero faces on every frame — which looks exactly
    // like an empty room, and would be read as the candidate being absent.
    expect(sessions.face.inputNames).toEqual(['input']);
    for (const stride of [8, 16, 32]) {
      for (const head of ['cls', 'obj', 'bbox', 'kps']) {
        expect(sessions.face.outputNames).toContain(`${head}_${stride}`);
      }
    }
  });

  it('the pose and gaze graphs declare the outputs their decoders read', () => {
    expect(sessions.pose.outputNames).toContain('rotation_matrix');
    expect(sessions.gaze.outputNames).toContain('yaw');
    expect(sessions.gaze.outputNames).toContain('pitch');
    expect(sessions.objects.outputNames).toContain('output');
  });

  it('accepts the exact input tensors the pipeline produces', async () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(frame(), WIDTH, HEIGHT);

    const faceOut = await run('face', pipe.faceInput(), [1, 3, 640, 640]);
    // 6400 + 1600 + 400 anchors, one score each.
    expect(faceOut.cls_8.dims).toEqual([1, 6400, 1]);
    expect(faceOut.bbox_32.dims).toEqual([1, 400, 4]);
    expect(faceOut.kps_16.dims).toEqual([1, 1600, 10]);

    const objectOut = await run('objects', pipe.objectInput(), [1, 3, 416, 416]);
    // 52^2 + 26^2 + 13^2 = 3549 anchors, 4 box + 1 objectness + 80 classes.
    expect(objectOut.output.dims).toEqual([1, 3549, 85]);
  }, 60_000);

  it('runs a whole frame end to end and produces well-formed signals', async () => {
    const pipe = new VigiloPipeline();
    pipe.beginFrame(frame(), WIDTH, HEIGHT);

    const bag = new TensorBag();
    const faceOut = await run('face', pipe.faceInput(), [1, 3, 640, 640]);
    for (const [name, tensor] of Object.entries(faceOut)) {
      bag.set(name, tensor.data as Float32Array);
    }
    const faces = pipe.decodeFace(bag) as FaceDetection[];

    // The synthetic frame has no face in it, and the detector is entitled to
    // say so. What is asserted is that whatever it returns is well formed —
    // a decoder reading the wrong stride layout produces boxes far outside
    // the frame rather than none at all.
    for (const face of faces) {
      expect(face.score).toBeGreaterThanOrEqual(0);
      expect(face.score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(face.bbox.w)).toBe(true);
      expect(face.bbox.w).toBeGreaterThan(0);
    }

    if (faces.length > 0) {
      const poseOut = await run('pose', pipe.poseInput(), [1, 3, 224, 224]);
      const pose = pipe.decodePose(poseOut.rotation_matrix.data as Float32Array) as {
        yaw_deg: number;
      };
      expect(Math.abs(pose.yaw_deg)).toBeLessThanOrEqual(180);

      if (pipe.gazeGate() === null) {
        const gazeOut = await run('gaze', pipe.gazeInput(), [1, 3, 448, 448]);
        expect((gazeOut.yaw.data as Float32Array).length).toBe(90);
        pipe.decodeGaze(gazeOut.yaw.data as Float32Array, gazeOut.pitch.data as Float32Array);
      }
    }

    const objectOut = await run('objects', pipe.objectInput(), [1, 3, 416, 416]);
    pipe.decodeObjects(objectOut.output.data as Float32Array);

    const { signals, events, active } = pipe.endFrame(0) as FrameResult;
    expect(signals.produced_by.face).toBe('produced');
    expect(signals.produced_by.objects).toBe('produced');
    expect(signals.produced_by.identity).toBe('not_configured');
    expect(Array.isArray(events)).toBe(true);
    expect(Array.isArray(active)).toBe(true);
  }, 60_000);

  it('measures the warm per-model budget the loop has to fit inside', async () => {
    // Not an assertion about speed — a measurement, printed. The face, pose
    // and gaze chain is what has to fit in one tick, so its sum is the number
    // that decides `faceHz`, and the gaze model's share is what decides
    // whether `gazeEvery` needs to be more than 1.
    //
    // Warm, not cold: the first inference on any graph is far slower than
    // steady state, and a budget set from it would pace the loop for a
    // condition that occurs once per session.
    const SHAPES: Record<keyof typeof MODELS, number[]> = {
      face: [1, 3, 640, 640],
      pose: [1, 3, 224, 224],
      gaze: [1, 3, 448, 448],
      objects: [1, 3, 416, 416],
    };

    const measured: Record<string, number> = {};
    for (const [slot, dims] of Object.entries(SHAPES)) {
      const size = dims.reduce((a, b) => a * b, 1);
      // Timing is a function of shape, not content, so zeros are honest here.
      const input = new Float32Array(size);

      await run(slot as keyof typeof MODELS, input, dims);
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        await run(slot as keyof typeof MODELS, input, dims);
        samples.push(timings[slot]);
      }
      samples.sort((a, b) => a - b);
      measured[slot] = samples[Math.floor(samples.length / 2)];
    }

    const chain = measured.face + measured.pose + measured.gaze;
    const halved = measured.face + measured.pose;

    const lines = [
      '',
      '  warm p50, single-threaded wasm:',
      ...Object.entries(measured).map(
        ([slot, ms]) => `  ${slot.padEnd(15)} ${ms.toFixed(0).padStart(5)} ms`
      ),
      `  ${'face+pose+gaze'.padEnd(15)} ${chain.toFixed(0).padStart(5)} ms` +
        `  -> ${(1000 / chain).toFixed(1)} Hz ceiling, gaze every frame`,
      `  ${'face+pose'.padEnd(15)} ${halved.toFixed(0).padStart(5)} ms` +
        `  -> ${(1000 / halved).toFixed(1)} Hz on the frames gaze skips`,
      '',
    ];
    console.log(lines.join('\n'));

    expect(measured.face).toBeGreaterThan(0);
    expect(measured.gaze).toBeGreaterThan(0);
  }, 300_000);
});
