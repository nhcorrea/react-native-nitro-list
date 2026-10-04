import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

describe('first paint', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('commits the first rows alone and fills the window on the next frame', () => {
    harness = renderNitroList({data: makeItems(1000), renderItem: () => null, estimatedItemSize: 50, keyExtractor: itemKey});
    harness.layout(400, 800);
    expect(harness.renderedIndices()).toEqual([0, 1, 2]);
    harness.frame();
    const filled = harness.renderedIndices();
    expect(filled[0]).toBe(0);
    expect(filled[filled.length - 1]).toBeGreaterThanOrEqual(800 / 50);
  });

  it('renders the whole first window at once when every item has a declared size', () => {
    harness = renderNitroList({
      data: makeItems(1000),
      renderItem: () => null,
      estimatedItemSize: 50,
      getFixedItemSize: () => 50,
      keyExtractor: itemKey,
    });
    harness.layout(400, 800);
    expect(harness.renderedIndices().length).toBeGreaterThan(3);
  });

  it('renders the whole landing window at once when the list mounts away from the top', async () => {
    harness = renderNitroList({
      data: makeItems(1000),
      renderItem: () => null,
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      initialScrollIndex: 500,
    });
    harness.layout(400, 800);
    await harness.settle(50);
    const rendered = harness.renderedIndices();
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered).toContain(500);
  });
});
