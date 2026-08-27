import {describe, expect, it} from '@jest/globals';

import {RANGE_EDGE_HYSTERESIS_ITEMS, stabilizeRange} from '../rangeHysteresis';

describe('stabilizeRange', () => {
  const prev = {start: 10, end: 30};

  it('keeps the trailing edge when the range retreats against a downward scroll', () => {
    const next = {start: 12, end: 29};
    expect(stabilizeRange(next, prev, 1, 1000)).toEqual({start: 12, end: 30});
  });

  it('keeps the leading edge when the range retreats against an upward scroll', () => {
    const next = {start: 11, end: 28};
    expect(stabilizeRange(next, prev, -1, 1000)).toEqual({start: 10, end: 28});
  });

  it('honors retreats larger than the hysteresis budget', () => {
    const next = {start: 10, end: 30 - RANGE_EDGE_HYSTERESIS_ITEMS - 1};
    expect(stabilizeRange(next, prev, 1, 1000)).toBe(next);
  });

  it('never blocks a normal unmount on the trailing side of the scroll', () => {
    expect(stabilizeRange({start: 14, end: 32}, prev, 1, 1000)).toEqual({start: 14, end: 32});
    expect(stabilizeRange({start: 8, end: 27}, prev, -1, 1000)).toEqual({start: 8, end: 27});
  });

  it('applies both edges when stationary', () => {
    expect(stabilizeRange({start: 11, end: 29}, prev, 0, 1000)).toEqual({start: 10, end: 30});
  });

  it('returns the same object when nothing changes', () => {
    const next = {start: 10, end: 31};
    expect(stabilizeRange(next, prev, 1, 1000)).toBe(next);
  });

  it('passes empty ranges and disjoint jumps through untouched', () => {
    const empty = {start: 0, end: -1};
    expect(stabilizeRange(empty, prev, 1, 1000)).toBe(empty);
    expect(stabilizeRange({start: 5, end: 9}, empty, 1, 1000)).toEqual({start: 5, end: 9});
    const jump = {start: 500, end: 520};
    expect(stabilizeRange(jump, prev, 1, 1000)).toBe(jump);
  });

  it('clamps a kept edge to the item count', () => {
    expect(stabilizeRange({start: 10, end: 18}, {start: 10, end: 19}, 1, 19)).toEqual({
      start: 10,
      end: 18,
    });
  });
});
