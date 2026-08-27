import {describe, expect, it} from '@jest/globals';

import {classifyScrollEvent} from '../scrollEvents';

describe('classifyScrollEvent', () => {
  it('classifies ordinary deltas as user scrolls', () => {
    expect(classifyScrollEvent(100, 80, 600, false)).toBe('user');
    expect(classifyScrollEvent(80, 100, 600, false)).toBe('user');
    expect(classifyScrollEvent(700, 100, 600, false)).toBe('user');
  });

  it('classifies deltas beyond one viewport as large jumps', () => {
    expect(classifyScrollEvent(701, 100, 600, false)).toBe('large-jump');
    expect(classifyScrollEvent(100, 5000, 600, false)).toBe('large-jump');
  });

  it('programmatic animated scrolling wins over the large-jump heuristic', () => {
    expect(classifyScrollEvent(5000, 100, 600, true)).toBe('programmatic');
    expect(classifyScrollEvent(120, 100, 600, true)).toBe('programmatic');
  });

  it('never reports large jumps without a measured viewport', () => {
    expect(classifyScrollEvent(5000, 100, 0, false)).toBe('user');
  });
});
