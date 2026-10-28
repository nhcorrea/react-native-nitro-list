import {describe, expect, it, jest} from '@jest/globals';

import {
  deferIdleReserveForScroll,
  gestureSliceBudget,
  growAdmittedRange,
  idleReserveRange,
  rangeCovers,
  type IdleReserveState,
} from '../prewarmAdmission';

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
    const focus = {start: 30, end: 35};
    expect(growAdmittedRange(target, focus, null, 16, 1)).toEqual({start: 30, end: 45});
    expect(growAdmittedRange(target, focus, null, 16, -1)).toEqual({start: 20, end: 35});
  });

  it('trims an over-budget focus to its leading edge', () => {
    const focus = {start: 30, end: 49};
    expect(growAdmittedRange(target, focus, null, 10, 1)).toEqual({start: 30, end: 39});
    expect(growAdmittedRange(target, focus, null, 10, -1)).toEqual({start: 40, end: 49});
  });

  it('clamps focus into target', () => {
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

describe('idleReserveRange', () => {
  const offset = (index: number) => index * 100;
  const index = (value: number) => Math.floor(value / 100);

  it('reserves the span after the window while items remain below it', () => {
    expect(idleReserveRange({start: 0, end: 9}, 500, 1200, offset, index)).toEqual({range: {start: 10, end: 22}, direction: 1});
    expect(idleReserveRange({start: 480, end: 497}, 500, 1200, offset, index)).toEqual({range: {start: 498, end: 499}, direction: 1});
  });

  it('reserves the span before the window at the end of the list', () => {
    expect(idleReserveRange({start: 490, end: 499}, 500, 1200, offset, index)).toEqual({range: {start: 477, end: 489}, direction: -1});
    expect(idleReserveRange({start: 3, end: 499}, 500, 1200, offset, index)).toEqual({range: {start: 0, end: 2}, direction: -1});
  });

  it('has nothing to reserve when the window covers the list', () => {
    expect(idleReserveRange({start: 0, end: 499}, 500, 1200, offset, index)).toBeNull();
    expect(idleReserveRange({start: 0, end: -1}, 500, 1200, offset, index)).toBeNull();
    expect(idleReserveRange({start: 0, end: 9}, 0, 1200, offset, index)).toBeNull();
  });
});

describe('gestureSliceBudget', () => {
  it('admits only cells the pool already has, keeping some for the live edge', () => {
    expect(gestureSliceBudget(8, 20, 2)).toBe(8);
    expect(gestureSliceBudget(8, 5, 2)).toBe(3);
    expect(gestureSliceBudget(8, 2, 2)).toBe(0);
    expect(gestureSliceBudget(8, 0, 2)).toBe(0);
    expect(gestureSliceBudget(8, Number.POSITIVE_INFINITY, 2)).toBe(8);
  });
});

describe('deferIdleReserveForScroll', () => {
  it('does not schedule new work when no idle reserve is pending', () => {
    const clearTimer = jest.fn();
    const clearRange = jest.fn();
    const reschedule = jest.fn();
    const state: IdleReserveState = {timer: null, admission: null};

    deferIdleReserveForScroll(state, clearTimer, clearRange, reschedule);

    expect(clearTimer).not.toHaveBeenCalled();
    expect(clearRange).not.toHaveBeenCalled();
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('cancels only the idle admission and reschedules it for the next idle period', () => {
    const clearTimer = jest.fn();
    const clearRange = jest.fn();
    const reschedule = jest.fn();
    const cancelAck = jest.fn();
    const state: IdleReserveState = {timer: null, admission: {cancelAck}};

    deferIdleReserveForScroll(state, clearTimer, clearRange, reschedule);

    expect(state.admission).toBeNull();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(cancelAck).toHaveBeenCalledTimes(1);
    expect(clearRange).toHaveBeenCalledTimes(1);
    expect(reschedule).toHaveBeenCalledTimes(1);
  });
});
