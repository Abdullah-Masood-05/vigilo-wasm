import { describe, it, expect } from 'bun:test';
import * as wasm from '../pkg/vigilo_wasm.js';
import { ProctorSession, replay, getDefaultConfig, validateConfig } from '../ts/index.js';
import type { Signals } from '../ts/types.js';

function createBaseSignal(seq: number, t_ms: number): Signals {
  return {
    seq,
    t_ms,
    faces: [],
    head_pose: null,
    gaze: null,
    objects: [],
    identity_match: null,
    produced_by: {
      face: 'produced',
      pose: 'produced',
      gaze: 'produced',
      objects: 'produced',
      identity: 'produced',
    },
  };
}

describe('WasmFusionEngine Full Ruleset', () => {
  it('should initialize with default config and validate configs', () => {
    const engine = new wasm.WasmFusionEngine();
    expect(engine).toBeDefined();
    const active = engine.active();
    expect(active).toEqual([]);

    const cfg = getDefaultConfig();
    expect(cfg).toBeDefined();
    expect(validateConfig(JSON.stringify(cfg))).toBe(true);
  });

  it('should detect NoFace violation after hold duration and clear when face returns', () => {
    const engine = new wasm.WasmFusionEngine();
    const s = createBaseSignal(1, 0);

    // Initial face
    s.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.95 }];
    let events = engine.step(s, 0);
    expect(events.length).toBe(0);

    // Face leaves at t = 1000
    s.faces = [];
    events = engine.step(s, 1000);
    expect(engine.active()).not.toContain('no_face');

    // Default no_face_hold_ms is 3000ms -> triggers at t >= 4000ms
    events = engine.step(s, 4500);
    expect(engine.active()).toContain('no_face');

    // Face returns at t = 5000
    s.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.95 }];
    engine.step(s, 5000);
    // After clear duration
    events = engine.step(s, 6500);
    expect(engine.active()).not.toContain('no_face');
  });

  it('should detect MultipleFaces violation', () => {
    const engine = new wasm.WasmFusionEngine();
    const s = createBaseSignal(1, 0);

    s.faces = [
      { bbox: { x: 50, y: 50, w: 100, h: 100 }, score: 0.9 },
      { bbox: { x: 200, y: 200, w: 100, h: 100 }, score: 0.88 },
    ];

    // Sustained multiple faces
    for (let t = 0; t <= 3000; t += 200) {
      s.t_ms = t;
      engine.step(s, t);
    }

    expect(engine.active()).toContain('multiple_faces');
  });

  it('should detect HeadTurnedAway violation with hysteresis', () => {
    const engine = new wasm.WasmFusionEngine();
    const s = createBaseSignal(1, 0);
    s.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.95 }];

    // Candidate turns head heavily (yaw = 45 deg)
    for (let t = 0; t <= 3500; t += 200) {
      s.t_ms = t;
      s.head_pose = { yaw_deg: 45.0, pitch_deg: 0.0, roll_deg: 0.0 };
      engine.step(s, t);
    }

    expect(engine.active()).toContain('head_turned_away');
  });

  it('should detect ProhibitedObject (phone accumulation) and clear on decay', () => {
    const engine = new wasm.WasmFusionEngine();
    const s = createBaseSignal(1, 0);
    s.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.9 }];

    // Repeatedly see cell phone with high score
    for (let t = 0; t <= 3000; t += 200) {
      s.t_ms = t;
      s.objects = [
        {
          bbox: { x: 50, y: 50, w: 60, h: 100 },
          class_id: 67,
          label: 'cell phone',
          score: 0.9,
        },
      ];
      engine.step(s, t);
    }

    expect(engine.active()).toContain('prohibited_object');

    // Phone removed: score decays (half-life is 15s, so allow 60s of decay)
    s.objects = [];
    for (let t = 3500; t <= 65000; t += 1000) {
      s.t_ms = t;
      engine.step(s, t);
    }

    expect(engine.active()).not.toContain('prohibited_object');
  });

  it('should deterministically replay a stream of signals', () => {
    const s1 = createBaseSignal(1, 0);
    s1.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.9 }];

    const s2 = createBaseSignal(2, 5000);
    s2.faces = []; // Absence

    const recorded = [s1, s2];
    const events = replay(recorded);
    expect(Array.isArray(events)).toBe(true);
  });

  it('ProctorSession event-driven API should emit callbacks and manage session lifecycle', () => {
    const session = new ProctorSession();
    let violationStartedCount = 0;
    let violationEndedCount = 0;

    session.onViolationStarted((v) => {
      violationStartedCount++;
      expect(v.kind).toBeDefined();
    });

    session.onViolationEnded((v) => {
      violationEndedCount++;
      expect(v.kind).toBeDefined();
    });

    const s = createBaseSignal(1, 0);
    s.faces = [{ bbox: { x: 100, y: 100, w: 200, h: 200 }, score: 0.9 }];
    session.step(s, 0);

    // Trigger prohibited object
    for (let t = 100; t <= 3500; t += 200) {
      s.t_ms = t;
      s.objects = [
        {
          bbox: { x: 50, y: 50, w: 60, h: 100 },
          class_id: 67,
          label: 'cell phone',
          score: 0.9,
        },
      ];
      session.step(s, t);
    }

    expect(violationStartedCount).toBeGreaterThan(0);
    expect(session.getActiveViolations()).toContain('prohibited_object');

    // Finish session -> closes active violation
    const endEvents = session.finish(4000);
    expect(endEvents.length).toBeGreaterThan(0);
    expect(violationEndedCount).toBeGreaterThan(0);
  });
});
