# Violations & Events

Data structures representing proctoring violation alerts, lifecycle events, and system degradation notices.

```ts
import type {
  Violation,
  ViolationKind,
  Severity,
  Event,
  ActiveViolation,
  Contribution,
  DegradeReason,
} from 'vigilo-wasm';
```

---

## `Violation`

Represents an ongoing or completed proctoring rule violation:

```ts
interface Violation {
  /** The violation category. */
  kind: ViolationKind;
  /** Severity rating. */
  severity: Severity;
  /** Normalized confidence score [0.0 - 1.0]. */
  confidence: number;
  /** Session timestamp when violation opened (in ms). */
  t_start_ms: number;
  /** Session timestamp when violation closed (null if still active). */
  t_end_ms: number | null;
  /** Optional subject identifier (e.g. object label like "cell phone"). */
  subject: string | null;
  /** Optional reference to an evidence artifact. */
  evidence: EvidenceRef | null;
  /** Breakdown of signals that contributed to opening this violation. */
  contributing: Contribution[];
}
```

---

## `ViolationKind`

| Kind | Trigger Condition |
|---|---|
| `no_face` | No face detected in the frame for longer than `face_absent_hold_ms`. |
| `multiple_faces` | Two or more faces present in the frame. |
| `head_turned_away` | Head yaw or pitch exceeds allowed thresholds for sustained duration. |
| `gaze_off_screen` | Gaze yaw or pitch deviates outside the screen boundary. |
| `prohibited_object` | Unauthorized object (cell phone, book, earbud) detected in the scene. |
| `never_seen` | Candidate never appeared in front of camera at start of exam. |
| `signal_lost` | Camera feed cut or frame pipeline stalled. |
| `identity_mismatch` | Facial identity verification failure (desktop engine only). |

---

## `Severity`

- `'info'`: Low-risk or informational event.
- `'low'`: Minor transient distraction.
- `'medium'`: Definite anomaly requiring reviewer inspection.
- `'high'`: Sustained breach (e.g. looking away for 10 seconds).
- `'critical'`: Blatant infraction (e.g. phone in hand, secondary person present).

---

## `Event`

An internally-tagged union of all events emitted by the engine:

```ts
type Event =
  | ({ event: 'violation_started' } & Violation)
  | ({ event: 'violation_ended' } & Violation)
  | ({ event: 'degraded' } & DegradeReason)
  | { event: 'recovered' }
  | { event: 'calibration_progress'; pct: number }
  | { event: 'calibration_complete' };
```

### Type Guard

```ts
import { isViolationEvent } from 'vigilo-wasm';

vigilo.onEvent((e) => {
  if (isViolationEvent(e)) {
    console.log(`Violation ${e.event}: ${e.kind}`);
  }
});
```

---

## `ActiveViolation`

A compact tuple `[ViolationKind, string | null]` indicating which violations are currently open as of the latest frame:

```ts
const active: ActiveViolation[] = vigilo.active;

for (const [kind, subject] of active) {
  console.log(`Currently violating: ${kind} (${subject ?? 'primary'})`);
}
```
