import {describe, expect, it} from '@jest/globals';

import {nextContainerSize} from '../containerSize';

describe('nextContainerSize', () => {
  const viewport = 800;

  it('starts from the exact total', () => {
    expect(nextContainerSize(0, 50000, 0, viewport)).toBe(50000);
  });

  it('keeps the container while the total moves a little far from the end', () => {
    expect(nextContainerSize(50000, 49990, 1000, viewport)).toBe(50000);
    expect(nextContainerSize(50000, 49000, 1000, viewport)).toBe(50000);
  });

  it('grows past the total with slack when the total outgrows the container', () => {
    expect(nextContainerSize(50000, 50010, 1000, viewport)).toBe(50010 + 5001);
    expect(nextContainerSize(5000, 5010, 0, 100)).toBe(5010 + 501);
    expect(nextContainerSize(5000, 5010, 0, 400)).toBe(5010 + 800);
  });

  it('follows the exact total near the end', () => {
    expect(nextContainerSize(52000, 49000, 47000, viewport)).toBe(49000);
    expect(nextContainerSize(50000, 50010, 48000, viewport)).toBe(50010);
  });

  it('follows the exact total when the content is short', () => {
    expect(nextContainerSize(5000, 2000, 0, viewport)).toBe(2000);
  });
});
