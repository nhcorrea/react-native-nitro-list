import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListOnViewableItemsChanged, NitroListViewToken} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('alwaysRender pinning (T25)', () => {
  let harness: NitroListHarness;
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  it('keeps top/bottom/index/key cells mounted outside the live window', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      alwaysRender: {top: 2, bottom: 2, indices: [50], keys: ['item-70']},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(10_000);
    await harness.settle(50);
    const indices = harness.renderedIndices();
    expect(indices).toContain(0);
    expect(indices).toContain(1);
    expect(indices).toContain(50);
    expect(indices).toContain(70);
    expect(indices).toContain(198);
    expect(indices).toContain(199);
    expect(indices).toContain(100);
    expect(indices).not.toContain(10);
  });

  it('pinned cells outside the live range never report viewability', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      alwaysRender: {bottom: 3},
      viewabilityConfig: {itemVisiblePercentThreshold: 1},
      onViewableItemsChanged: spy as unknown as NitroListOnViewableItemsChanged<string>,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    for (const call of spy.mock.calls) {
      const info = call[0] as {viewableItems: NitroListViewToken<string>[]};
      for (const token of info.viewableItems) {
        expect(token.index).toBeLessThan(190);
      }
    }
    expect(harness.renderedIndices()).toContain(199);
  });
});
