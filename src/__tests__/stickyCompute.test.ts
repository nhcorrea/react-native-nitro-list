import {describe, expect, it} from '@jest/globals';

import {computeSticky, createStickyResult, sameStickyPush, stickyPushFor} from '../stickyCompute';

const reader = {
  getItemOffset: (index: number) => index * 100,
  getItemSize: () => 100,
};

describe('stickyPushFor', () => {
  it('starts the push when the next header reaches the bottom of the active one', () => {
    const result = computeSticky(950, [0, 10, 20], 0, reader, 0, createStickyResult());
    expect(stickyPushFor(result, [0, 10, 20], 0, reader, 0)).toEqual({start: 900, end: 1000, from: 0, to: -100});
  });

  it('shifts the range by the scroll origin and keeps the sticky offset', () => {
    const result = computeSticky(950, [0, 10, 20], 20, reader, 50, createStickyResult());
    expect(stickyPushFor(result, [0, 10, 20], 20, reader, 30)).toEqual({start: 960, end: 1010, from: 20, to: -30});
  });

  it('pins the last header without a push', () => {
    const result = computeSticky(2500, [0, 10, 20], 0, reader, 0, createStickyResult());
    expect(result.index).toBe(20);
    expect(stickyPushFor(result, [0, 10, 20], 0, reader, 0)).toEqual({start: 0, end: 1, from: 0, to: 0});
  });

  it('matches the translation computed on the JS side inside the range', () => {
    const indices = [0, 10, 20];
    for (const offset of [900, 925, 950, 999]) {
      const result = computeSticky(offset, indices, 0, reader, 0, createStickyResult());
      const push = stickyPushFor(result, indices, 0, reader, 0);
      const t = (offset - push.start) / (push.end - push.start);
      expect(push.from + t * (push.to - push.from)).toBeCloseTo(result.translateY);
    }
  });
});

describe('sameStickyPush', () => {
  it('compares every field', () => {
    const push = {start: 1, end: 2, from: 0, to: -1};
    expect(sameStickyPush(null, push)).toBe(false);
    expect(sameStickyPush({...push}, push)).toBe(true);
    expect(sameStickyPush({...push, to: -2}, push)).toBe(false);
  });
});
