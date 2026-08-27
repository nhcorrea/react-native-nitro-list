import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

describe('harness smoke', () => {
  let harness: NitroListHarness;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    harness?.unmount();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
  });

  it('mounts, ranges, measures and scrolls against the mirror', () => {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(400, 600);

    expect(harness.renderedIndices()[0]).toBe(0);
    expect(harness.renderedIndices().length).toBeGreaterThan(0);

    harness.frame();
    const expanded = harness.renderedIndices();
    expect(expanded[expanded.length - 1]).toBe(8);

    harness.measureAllCells(() => 150);
    harness.frame();
    expect(harness.handle.getItemSize(0)).toBe(150);
    expect(harness.handle.getTotalSize()).toBe(100 * 150);

    harness.scroll(3000);
    const afterScroll = harness.renderedIndices();
    expect(afterScroll[0]).toBeGreaterThan(0);
    expect(harness.lastScrollTop()).toBe(3000);
  });
});
