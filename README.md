# vigilo-wasm

[![WebAssembly](https://img.shields.io/badge/WebAssembly-WASM-654FF0?logo=webassembly&logoColor=white)](https://webassembly.org/)
[![Bun](https://img.shields.io/badge/Bun-1.4+-black?logo=bun&logoColor=white)](https://bun.sh/)
[![Rust](https://img.shields.io/badge/Rust-1.80+-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

**High-performance WebAssembly multimodal proctoring stream fusion and behavioral engine in pure Rust for Bun, Node.js, and Modern Browsers.**

Powered by the battle-tested [vigilo-core](https://github.com/Abdullah-Masood-05/vigilo-core) engine with **zero browser UI dependencies**, **zero Tauri requirements**, and **deterministic replay guarantees**.

---

## Features

- **⚡ Sub-Millisecond Temporal Fusion**: `WasmFusionEngine` processes frame signals in **< 0.05 ms**, turning raw per-frame detections into stable, debounced violation claims.
- **🎯 Deterministic State Machine**: Replaying the same stream of `Signals` produces bit-identical `Violation` and `Event` sequences every time.
- **👁️ Direction & Gaze Tracking**: Angular head yaw/pitch and gaze bucketing (`LEFT`, `RIGHT`, `UP`, `DOWN`, `CENTER`) from the subject's frame of reference with camera pitch offset compensation.
- **🚀 Ultra-Fast Vision Geometry**:
  - `calculate_iou`: Native WASM Intersection-over-Union calculation.
  - `non_max_suppression`: Greedy NMS for bounding box candidate deduplication.
- **🛡️ Full Proctoring Ruleset**:
  - `never_seen`: Candidate never appeared in frame.
  - `no_face`: Candidate left the camera view (debounced with hold timer).
  - `multiple_faces`: Multiple individuals detected in frame.
  - `head_turned_away`: Sustained head yaw/pitch deviations with hysteresis gates.
  - `gaze_off_screen`: Eye-in-head gaze deviation away from screen.
  - `prohibited_object`: Phone, book, or unauthorized device accumulation with half-life score decay.
  - `signal_lost`: Tracking model failure or gating conditions.
  - `identity_mismatch`: Sustained biometric verification drop.
- **📦 Bun First & Universal**: Seamless support for Bun, Node.js, Next.js, Vite, and browser bundlers.

---

## Installation

```bash
# Using Bun
bun add vigilo-wasm

# Using npm
npm install vigilo-wasm

# Using pnpm
pnpm add vigilo-wasm
```

---

## Quick Start

### 1. High-Level Event-Driven API (`ProctorSession`)

```typescript
import { createProctorSession } from 'vigilo-wasm';

// Initialize session with default thresholds
const session = createProctorSession();

// Listen to proctoring events
session.onViolationStarted((violation) => {
  console.warn(`[ALERT] ${violation.kind} started! Severity: ${violation.severity}`);
  console.log(`Contributing signals:`, violation.contributing);
});

session.onViolationEnded((violation) => {
  console.info(`[CLEARED] ${violation.kind} ended at ${violation.t_end_ms} ms`);
});

// In your camera/inference frame loop:
const events = session.step({
  seq: 1,
  t_ms: Date.now(),
  faces: [
    {
      bbox: { x: 120, y: 80, w: 200, h: 220 },
      score: 0.98,
    },
  ],
  head_pose: { yaw_deg: -2.5, pitch_deg: 5.1, roll_deg: 0.2 },
  gaze: { yaw_rad: -0.04, pitch_rad: 0.08 },
  objects: [],
  produced_by: {
    face: 'produced',
    pose: 'produced',
    gaze: 'produced',
    objects: 'produced',
    identity: 'produced',
  },
});

// Check active violations on demand:
const active = session.getActiveViolations(); // e.g. ['no_face']
```

### 2. Direction & Head Pose Bucketing

```typescript
import { wasm } from 'vigilo-wasm';

const tracker = new wasm.WasmDirectionTracker();

// Update with head pose angles (yaw, pitch)
const dir = tracker.update(35.0, 0.0, null, null);
console.log(dir.head.horizontal); // 'RIGHT' (subject's point of view)
console.log(dir.head.vertical);   // 'CENTER'
```

### 3. Non-Maximum Suppression (NMS) & IoU

```typescript
import { iou, nms } from 'vigilo-wasm';

const boxA = { x: 0, y: 0, w: 100, h: 100 };
const boxB = { x: 50, y: 0, w: 100, h: 100 };
console.log(iou(boxA, boxB)); // 0.3333

const candidates = [
  { class_id: 67, bbox: { x: 10, y: 10, w: 50, h: 50 }, score: 0.95 },
  { class_id: 67, bbox: { x: 12, y: 11, w: 49, h: 51 }, score: 0.82 },
];
const kept = nms(candidates, 0.45, 10);
console.log(kept.length); // 1
```

### 4. Deterministic Session Replay

```typescript
import { replay } from 'vigilo-wasm';

// Replay a recorded JSONL stream of signals
const recordedSignals = [ /* array of Signals */ ];
const events = replay(recordedSignals);
console.log(`Replay generated ${events.length} violation events.`);
```

---

## Building from Source

Prerequisites:
- [Rust 1.80+](https://www.rust-lang.org/) with `wasm32-unknown-unknown` target.
- [wasm-pack](https://rustwasm.github.io/wasm-pack/) (`cargo binstall wasm-pack`).
- [Bun](https://bun.sh/) 1.1+.

```bash
# Clone the repository
git clone https://github.com/Abdullah-Masood-05/vigilo-wasm.git
cd vigilo-wasm

# Build WebAssembly package
bun run build:wasm

# Run test suite
bun test
```

---

## Architecture

```
vigilo-wasm/
├── src/
│   ├── lib.rs              # wasm-bindgen exports (FusionEngine, DirectionTracker, NMS, Replay)
│   └── models.rs           # COCO class table & lightweight vision helpers
├── pkg/                    # Compiled WASM binaries & JS/TS glue code
├── ts/
│   ├── index.ts            # Public API exports
│   ├── session.ts          # ProctorSession state machine
│   └── types.ts            # TypeScript interfaces
├── tests/
│   ├── fusion.test.ts      # Bun test suite for temporal fusion
│   └── direction.test.ts   # Bun test suite for direction tracking & vision math
├── package.json
└── Cargo.toml
```

---

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`). See [LICENSE](LICENSE) for details.
