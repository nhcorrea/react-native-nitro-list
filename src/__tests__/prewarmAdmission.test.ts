import {describe, expect, it} from '@jest/globals';

import {growAdmittedRange, rangeCovers} from '../prewarmAdmission';

describe('rangeCovers', () => {
  it('is true only when outer contains inner', () => {
    expect(rangeCovers({start: 0, end: 10}, {start: 3, end: 7})).toBe(true);
    expect(rangeCovers({start: 0, end: 10}, {start: 0, end: 10})).toBe(true);
    expect(rangeCovers({start: 0, end: 10}, {start: 3, end: 11})).toBe(false);
    expect(rangeCovers({start: 4, end: 10}, {start: 3, end: 7})).toBe(false);
  });
});

describe('growAdmittedRange — first slice', () => {
  const target = {start: 0, end: 79};

  it('admits the whole focus when it fits the budget, then grows outward in scroll direction', () => {
    const focus = {start: 30, end: 35}; // 6 items, budget 16 → 10 spare
    expect(growAdmittedRange(target, focus, null, 16, 1)).toEqual({start: 30, end: 45});
    expect(growAdmittedRange(target, focus, null, 16, -1)).toEqual({start: 20, end: 35});
  });

  it('trims an over-budget focus to its leading edge', () => {
    const focus = {start: 30, end: 49}; // 20 items > budget 10
    expect(growAdmittedRange(target, focus, null, 10, 1)).toEqual({start: 30, end: 39});
    expect(growAdmittedRange(target, focus, null, 10, -1)).toEqual({start: 40, end: 49});
  });

  it('clamps focus into target', () => {
    // Focus leaks past the window end — admitted must stay inside target.
    expect(growAdmittedRange({start: 0, end: 40}, {start: 36, end: 44}, null, 16, 1)).toEqual({
      start: 25,
      end: 40,
    });
  });

  it('falls back to the leading target edge when focus is disjoint from target', () => {
    expect(growAdmittedRange({start: 10, end: 20}, {start: 40, end: 45}, null, 16, 1)).toEqual({
      start: 10,
      end: 20,
    });
    expect(growAdmittedRange({start: 10, end: 60}, {start: 80, end: 85}, null, 8, -1)).toEqual({
      start: 53,
      end: 60,
    });
  });

  it('treats a non-positive budget as one item', () => {
    expect(growAdmittedRange(target, {start: 30, end: 45}, null, 0, 1)).toEqual({
      start: 30,
      end: 30,
    });
  });
});

describe('growAdmittedRange — growth', () => {
  const target = {start: 0, end: 79};

  it('extends toward scroll direction first', () => {
    expect(growAdmittedRange(target, {start: 30, end: 45}, {start: 30, end: 45}, 16, 1)).toEqual({
      start: 30,
      end: 61,
    });
    expect(growAdmittedRange(target, {start: 30, end: 45}, {start: 30, end: 45}, 16, -1)).toEqual({
      start: 14,
      end: 45,
    });
  });

  it('spills leftover budget to the other side when one side is exhausted', () => {
    const smallTarget = {start: 0, end: 50};
    expect(
      growAdmittedRange(smallTarget, {start: 30, end: 48}, {start: 30, end: 48}, 10, 1),
    ).toEqual({start: 22, end: 50});
  });

  it('converges to covering the full target in bounded slices', () => {
    let admitted: {start: number; end: number} | null = null;
    let slices = 0;
    do {
      admitted = growAdmittedRange(target, {start: 30, end: 45}, admitted, 16, 1);
      slices++;
    } while (!rangeCovers(admitted, target) && slices < 100);
    expect(rangeCovers(admitted, target)).toBe(true);
    // 80 items at 16/slice = 5 slices — a full window costs ~5 frames.
    expect(slices).toBe(5);
  });

  it('never admits more than the budget per slice', () => {
    let admitted: {start: number; end: number} | null = null;
    let prevCount = 0;
    for (let i = 0; i < 10; i++) {
      admitted = growAdmittedRange(target, {start: 30, end: 45}, admitted, 16, 1);
      const count = admitted.end - admitted.start + 1;
      expect(count - prevCount).toBeLessThanOrEqual(16);
      prevCount = count;
    }
  });
});
