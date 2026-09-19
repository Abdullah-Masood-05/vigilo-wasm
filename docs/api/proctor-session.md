# ProctorSession & Replay

The temporal engine interface for processing `Signals` and executing deterministic replays.

```ts
import {
  ProctorSession,
  replay,
  iou,
  nms,
  getDefaultConfig,
  validateConfig,
} from 'vigilo-wasm';
```

---

## `replay()`

Executes recorded `Signals` through the compiled Rust temporal fusion engine.

```ts
function replay(signals: Signals[] | string, config?: Config | string): Event[];
```

### Example
```ts
import { initVigilo, replay } from 'vigilo-wasm';

await initVigilo();

const events = replay(savedSignals, {
  thresholds: {
    gaze_hold_ms: 1500,
  },
});
```

Because fusion is a pure function of inputs and discrete time `t_ms`, identical signals produce a byte-identical event sequence.

---

## `ProctorSession`

Stateful temporal fusion session.

```ts
class ProctorSession {
  constructor(config?: Config | string);

  /** Feed one instantaneous Signals object and advance the session clock to tMs. */
  step(signals: Signals | string, tMs: number): Event[];

  /** Conclude the session, closing all active violations. */
  finish(tMs: number): Event[];

  /** Drop all temporal history, resetting the clock to 0. */
  reset(): void;

  /** Inspect the current configuration. */
  config(): Config;

  /** Enable or disable downstream model slots in fusion rules. */
  configureSlots(pose: boolean, gaze: boolean, objects: boolean): void;

  /** Subscribe to violation start/end callbacks. */
  onViolationStarted(fn: (v: Violation) => void): () => void;
  onViolationEnded(fn: (v: Violation) => void): () => void;
  onEvent(fn: (e: Event) => void): () => void;
}
```

---

## Geometric & Utility Functions

### `iou(boxA: BBox, boxB: BBox): number`
Computes the Intersection-over-Union between two bounding boxes.

### `nms<T>(candidates: T[], iouThreshold = 0.45, topK = 100): T[]`
Greedy class-aware non-maximum suppression executed in compiled Rust. Preserves custom properties attached to candidate objects.

### `getDefaultConfig(): Config`
Returns the default engine configuration object with all thresholds and cadences filled in.

### `validateConfig(configJson: string): boolean`
Validates a JSON configuration string against the Rust engine's schema. Throws an error detailing schema violations if invalid.
