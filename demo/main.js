/**
 * The demo — the shortest honest path from a webcam to a violation.
 *
 * Plain ESM, no bundler. `onnxruntime-web` is imported from `node_modules` and
 * handed to `loadModels`, which is the pattern the library is built around:
 * nothing here resolves a bare specifier, so a page with an import map or a
 * CDN copy of ORT works the same way.
 *
 * Run it with `bun run demo`. The camera needs a secure context, and
 * `localhost` is one.
 */

import * as ort from '/node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs';
import {
  initVigilo,
  CameraSource,
  loadModels,
  VigiloBrowser,
  isCrossOriginIsolated,
} from '../dist/index.js';

const el = (id) => document.getElementById(id);
const status = el('status');
const video = el('video');
const overlay = el('overlay');
const ctx = overlay.getContext('2d');

let camera = null;
let models = null;
let runtime = null;

function say(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function log(kind, text) {
  const line = document.createElement('div');
  line.className = kind;
  const at = runtime ? (runtime.latencies.frames / Math.max(1, runtime.latencies.fps)).toFixed(1) : '0.0';
  line.textContent = `${at.padStart(6)}s  ${text}`;
  el('log').prepend(line);
  while (el('log').childElementCount > 200) el('log').lastElementChild.remove();
}

el('start').addEventListener('click', start);
el('stop').addEventListener('click', stop);

async function start() {
  el('start').disabled = true;
  try {
    say('Loading the engine…');
    await initVigilo();

    say('Requesting the camera…');
    camera = await CameraSource.open({ video });

    const useWebGPU = el('webgpu').checked;
    const wantObjects = el('objects').checked;

    say('Downloading models (cached after the first run)…');
    models = await loadModels(
      {
        // fp32, not int8: quantized conv has no fast wasm kernel and
        // measures 4x slower here. See scripts/bench.ts.
        face: './models/face_detection_yunet_2023mar.onnx',
        pose: './models/headpose_mobilenetv3_small.onnx',
        gaze: './models/mobileone_s0_gaze.onnx',
        ...(wantObjects ? { objects: './models/yolox_nano.onnx' } : {}),
      },
      {
        ort,
        wasmPaths: '/node_modules/onnxruntime-web/dist/',
        executionProviders: useWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
        onProgress: (slot, loaded, total) => {
          const pct = total ? ` ${Math.round((loaded / total) * 100)}%` : '';
          say(`Downloading ${slot}${pct}…`);
        },
      }
    );

    for (const { slot, error } of models.failed) {
      log('degraded', `${slot} model unavailable: ${error}`);
    }

    runtime = await VigiloBrowser.create({ camera, models, ort });

    runtime.onEvent((event) => {
      if (event.event === 'violation_started') {
        log('started', `${event.kind}${event.subject ? ` (${event.subject})` : ''} started`);
      } else if (event.event === 'violation_ended') {
        const seconds = ((event.t_end_ms - event.t_start_ms) / 1000).toFixed(1);
        log('ended', `${event.kind}${event.subject ? ` (${event.subject})` : ''} ended after ${seconds}s`);
      } else if (event.event === 'degraded') {
        log('degraded', `degraded: ${event.reason}`);
      } else if (event.event === 'recovered') {
        log('ended', 'recovered');
      }
    });

    runtime.onFrame(draw);
    runtime.start();

    el('stop').disabled = false;
    const threads = isCrossOriginIsolated() ? `${ort.env.wasm.numThreads} threads` : '1 thread (not cross-origin isolated)';
    say(`Running — ${useWebGPU ? 'webgpu → wasm' : 'wasm'}, ${threads}.`);
  } catch (error) {
    console.error(error);
    say(String(error?.message ?? error), true);
    el('start').disabled = false;
  }
}

function stop() {
  if (runtime) {
    // `finish` rather than `stop`: a violation that is open when the session
    // ends still needs its end event, or it reads as zero-length afterwards.
    runtime.finish();
    runtime = null;
  }
  camera?.close();
  camera = null;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  el('start').disabled = false;
  el('stop').disabled = true;
  say('Stopped.');
}

window.addEventListener('beforeunload', () => runtime?.finish());

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

const fmt = (v, digits = 1) => (v === null || v === undefined ? '—' : v.toFixed(digits));
const deg = (rad) => (rad === null || rad === undefined ? null : (rad * 180) / Math.PI);

function draw({ signals, active, total_ms, stages }) {
  const { faces, head_pose: pose, gaze, objects, produced_by: cov, debug_directions: dirs } = signals;

  if (overlay.width !== camera.width || overlay.height !== camera.height) {
    overlay.width = camera.width;
    overlay.height = camera.height;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // The primary face is index 0 — the highest-scoring box, and the only one
  // pose and gaze were measured from. Drawing the rest in a different colour
  // keeps that visible rather than implied.
  faces.forEach((face, i) => {
    box(face.bbox, i === 0 ? '#58a6ff' : '#8b949e', `${(face.score * 100).toFixed(0)}%`);
    if (face.keypoints && i === 0) {
      ctx.fillStyle = '#58a6ff';
      for (const [x, y] of Object.values(face.keypoints)) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  for (const object of objects) {
    box(object.bbox, '#f85149', `${object.label} ${(object.score * 100).toFixed(0)}%`);
  }

  el('s-faces').textContent = String(faces.length);
  el('s-pose').textContent = pose ? `${fmt(pose.yaw_deg)}° / ${fmt(pose.pitch_deg)}°` : '—';
  el('s-gaze').textContent = gaze
    ? `${fmt(deg(gaze.yaw_rad))}° / ${fmt(deg(gaze.pitch_rad))}°`
    : '—';
  el('s-eye').textContent =
    gaze && gaze.eye_yaw_rad !== null
      ? `${fmt(deg(gaze.eye_yaw_rad))}° / ${fmt(deg(gaze.eye_pitch_rad))}°`
      : '—';
  // `null` and `CENTER` mean very different things and must not render alike.
  el('s-dir').textContent = dirs?.head
    ? `head ${dirs.head.horizontal}/${dirs.head.vertical}` +
      (dirs.eye ? ` · eye ${dirs.eye.horizontal}/${dirs.eye.vertical}` : '')
    : '—';
  el('s-objects').textContent = objects.length
    ? objects.map((o) => o.label).join(', ')
    : cov.objects === 'produced'
      ? 'none'
      : '—';

  for (const slot of ['face', 'pose', 'gaze', 'objects', 'identity']) {
    const node = el(`c-${slot}`);
    node.textContent = cov[slot] + (slot === 'gaze' && cov.gaze_gate ? ` (${cov.gaze_gate})` : '');
    node.style.color = cov[slot] === 'produced' ? 'var(--ok)' : cov[slot] === 'failed' ? 'var(--bad)' : 'var(--muted)';
  }

  const list = el('violations');
  list.textContent = '';
  for (const [kind, subject] of active) {
    const row = document.createElement('div');
    row.className = 'violation';
    row.innerHTML = `<span>${kind}</span><span>${subject ?? ''}</span>`;
    list.append(row);
  }

  const lat = runtime.latencies;
  el('l-fps').textContent = lat.fps.toFixed(1);
  el('l-total').textContent = `${lat.total_p50.toFixed(0)} / ${lat.total_p95.toFixed(0)} ms`;
  for (const slot of ['face', 'pose', 'gaze', 'objects']) {
    const p50 = lat.stages[slot];
    el(`l-${slot}`).textContent = p50 ? `${p50.toFixed(0)} ms` : '—';
  }
  void total_ms;
  void stages;
}

function box(bbox, colour, label) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);

  if (!label) return;
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  const width = ctx.measureText(label).width + 8;
  ctx.fillStyle = colour;
  ctx.fillRect(bbox.x, bbox.y - 18, width, 18);

  // The stage is mirrored, so text drawn normally would come out backwards.
  ctx.save();
  ctx.translate(bbox.x + width / 2, bbox.y - 9);
  ctx.scale(-1, 1);
  ctx.fillStyle = '#06121f';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}
