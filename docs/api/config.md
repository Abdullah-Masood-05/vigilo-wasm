# Configuration Schema

The `Config` interface defines cadences, thresholds, and operational limits for the proctoring engine.

```ts
import { getDefaultConfig, validateConfig, type Config } from 'vigilo-wasm';
```

---

## Schema Overview

```ts
interface Config {
  cadence?: {
    face_hz?: number;     // Target rate for face/pose/gaze (default: 10.0)
    object_hz?: number;   // Target rate for objects (default: 1.0)
    identity_hz?: number; // Identity rate (unused in browser)
  };
  thresholds?: {
    // Head pose limits (in degrees)
    head_turn_yaw_deg?: number;    // Default: 30.0
    head_turn_pitch_deg?: number;  // Default: 20.0
    head_turn_hold_ms?: number;    // Default: 1200

    // Gaze limits (in radians)
    gaze_yaw_rad?: number;         // Default: 0.35 rad (~20 deg)
    gaze_pitch_rad?: number;       // Default: 0.25 rad (~14 deg)
    gaze_hold_ms?: number;         // Default: 1500

    // Face presence timers
    face_absent_hold_ms?: number;  // Default: 2000
    multiple_faces_hold_ms?: number; // Default: 800

    // Object detection
    object_confidence_threshold?: number; // Default: 0.45
  };
}
```

---

## Utility Functions

### `getDefaultConfig(): Config`
Returns the built-in default engine configuration with all fields populated:

```ts
const defaults = getDefaultConfig();
console.log('Default face_hz:', defaults.cadence?.face_hz);
```

### `validateConfig(configJson: string): boolean`
Validates a JSON configuration string against the Rust engine's internal schema. Throws an error if invalid:

```ts
try {
  validateConfig(JSON.stringify(myCustomConfig));
  console.log('Config is valid!');
} catch (err) {
  console.error('Config validation failed:', err);
}
```
