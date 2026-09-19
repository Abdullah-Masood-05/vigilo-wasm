import { describe, it, expect } from 'bun:test';
import * as wasm from '../pkg/vigilo_wasm.js';
import { iou, nms } from '../ts/index.js';

describe('WasmDirectionTracker & Utilities', () => {
  it('should track head pose directions accurately', () => {
    const tracker = new wasm.WasmDirectionTracker();

    // Looking forward / center
    let dir = tracker.update(0.0, 0.0, null, null);
    expect(dir.head.horizontal).toBe('CENTER');
    expect(dir.head.vertical).toBe('CENTER');

    // Yaw > 0 is subject's right
    dir = tracker.update(35.0, 0.0, null, null);
    expect(dir.head.horizontal).toBe('RIGHT');

    // Yaw < 0 is subject's left
    dir = tracker.update(-35.0, 0.0, null, null);
    expect(dir.head.horizontal).toBe('LEFT');

    // Pitch > 0 is UP
    dir = tracker.update(0.0, 30.0, null, null);
    expect(dir.head.vertical).toBe('UP');

    // Pitch < 0 is DOWN
    dir = tracker.update(0.0, -30.0, null, null);
    expect(dir.head.vertical).toBe('DOWN');
  });

  it('should calculate accurate IoU in WebAssembly', () => {
    const boxA = { x: 0, y: 0, w: 100, h: 100 };
    const boxB = { x: 50, y: 0, w: 100, h: 100 };

    const score = iou(boxA, boxB);
    // Intersection: 50x100 = 5000, Union: 150x100 = 15000 -> IoU = 1/3 ~ 0.3333
    expect(score).toBeCloseTo(0.3333, 2);

    // Identical boxes
    expect(iou(boxA, boxA)).toBeCloseTo(1.0, 4);

    // Disjoint boxes
    const boxC = { x: 200, y: 200, w: 50, h: 50 };
    expect(iou(boxA, boxC)).toBe(0);
  });

  it('should perform greedy NMS deduplication', () => {
    const candidates = [
      { class_id: 1, bbox: { x: 10, y: 10, w: 50, h: 50 }, score: 0.9 },
      { class_id: 1, bbox: { x: 12, y: 11, w: 49, h: 51 }, score: 0.8 }, // Highly overlapping -> should suppress
      { class_id: 1, bbox: { x: 100, y: 100, w: 50, h: 50 }, score: 0.85 }, // Disjoint -> should keep
    ];

    const kept = nms(candidates, 0.5, 10);
    expect(kept.length).toBe(2);
    expect(kept[0].score).toBeCloseTo(0.9, 2);
    expect(kept[1].score).toBeCloseTo(0.85, 2);
  });
});
