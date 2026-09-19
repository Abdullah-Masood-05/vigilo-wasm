# VigiloBrowser

The high-level orchestrator that schedules webcam capture, neural inference in `onnxruntime-web`, and temporal fusion in WebAssembly.

```ts
import { VigiloBrowser } from 'vigilo-wasm';
```

---

## Static Methods

### `VigiloBrowser.create(options: RuntimeOptions): Promise<VigiloBrowser>`
Instantiates a new browser runtime.

```ts
const vigilo = await VigiloBrowser.create({
  camera,
  models,
  faceHz: 10,
  objectHz: 1,
  poseEvery: 1,
  gazeEvery: 2,
});
```

#### `RuntimeOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `camera` | `CameraSource` | *Required* | An active `CameraSource` instance. |
| `models` | `LoadedModels` | *Required* | Models loaded via `loadModels()`. |
| `config` | `Config \| string` | `undefined` | Engine thresholds & cadences (JSON object or string). |
| `ort` | `OrtLike` | `undefined` | Custom `onnxruntime-web` namespace if not using global/bundled. |
| `faceHz` | `number` | `10` | Face-loop pacing rate in Hz. |
| `objectHz` | `number` | `1` | Object-detector target rate in Hz. |
| `poseEvery` | `number` | `1` | Run head pose on every Nth face frame. |
| `gazeEvery` | `number` | `2` | Run gaze on every Nth face frame. |

---

## Instance Methods

### `start(): void`
Starts the autonomous frame loop. Does nothing if already running.

### `stop(): void`
Pauses the detection loop. Keeps internal temporal state so that calling `start()` resumes seamlessly.

### `finish(): Event[]`
Stops the loop and closes all currently active violations, dispatching `violation_ended` events for each. Returns the closing events array.

### `reset(): void`
Clears temporal history and timers, resetting the session clock `t_ms` to 0. Loaded models and configuration are preserved.

### `onViolationStarted(listener: ViolationListener): () => void`
Registers a callback for new violations. Returns an unsubscribe function.

```ts
const unsub = vigilo.onViolationStarted((v: Violation) => {
  console.log(`Violation started: ${v.kind}`);
});
```

### `onViolationEnded(listener: ViolationListener): () => void`
Registers a callback when an active violation resolves. Returns an unsubscribe function.

### `onFrame(listener: FrameListener): () => void`
Registers a callback called at the end of every completed frame pass. Receives `FrameOutcome`:

```ts
vigilo.onFrame(({ signals, active, total_ms, stages }) => {
  console.log(`Frame total: ${total_ms}ms`, stages);
});
```

### `onEvent(listener: EventListener): () => void`
Subscribes to all events emitted by the pipeline (`violation_started`, `violation_ended`, `degraded`, `recovered`).

---

## Properties

### `active: ActiveViolation[]`
The list of violations currently open, as of the most recent completed frame:
`Array<[ViolationKind, string | null]>`.

### `latencies: Latencies`
Current performance metrics computed over the last 120 frames:

```ts
interface Latencies {
  fps: number;
  frames: number;
  total_p50: number; // Median tick latency in ms
  total_p95: number; // 95th percentile latency in ms
  stages: {
    face?: number;
    pose?: number;
    gaze?: number;
    objects?: number;
  };
}
```

### `pipeline: VigiloPipeline`
Access to the underlying Rust `VigiloPipeline` WASM struct.
