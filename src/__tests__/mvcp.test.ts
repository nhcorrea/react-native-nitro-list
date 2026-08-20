import {describe, expect, it} from '@jest/globals';

import {computeExecutableMvcpDelta, MVCP_ANCHOR_BASE} from '../mvcp';

describe('computeExecutableMvcpDelta', () => {
  it('applies the full diff when the target stays inside the scrollable range', () => {
    expect(computeExecutableMvcpDelta(500, 120, 2000)).toBe(120);
    expect(computeExecutableMvcpDelta(500, -120, 2000)).toBe(-120);
  });

  it('never restores while pinned at or above the top', () => {
    expect(computeExecutableMvcpDelta(0, 100, 2000)).toBe(0);
    expect(computeExecutableMvcpDelta(-40, 100, 2000)).toBe(0);
  });

  it('clamps to the end of the content and reports only the executable part', () => {
    expect(computeExecutableMvcpDelta(1900, 300, 2000)).toBe(100);
    expect(computeExecutableMvcpDelta(2000, 50, 2000)).toBe(0);
  });

  it('clamps negative diffs at the top edge', () => {
    expect(computeExecutableMvcpDelta(80, -200, 2000)).toBe(-80);
  });

  it('pulls back when the content shrank below the current offset', () => {
    expect(computeExecutableMvcpDelta(1500, 40, 1200)).toBe(-300);
    expect(computeExecutableMvcpDelta(1500, -100, 1200)).toBe(-300);
  });

  it('treats a negative max scroll extent as zero', () => {
    expect(computeExecutableMvcpDelta(10, 50, -5)).toBe(-10);
  });

  it('keeps the anchor base far beyond any realistic content extent', () => {
    expect(MVCP_ANCHOR_BASE).toBeGreaterThanOrEqual(10_000_000);
  });
});
