import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListOnViewableItemsChanged, NitroListViewToken} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

type ViewabilityCall = {
  viewableItems: NitroListViewToken<string>[];
  changed: NitroListViewToken<string>[];
};

describe('viewability integration', () => {
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

  function viewableIndices(call: ViewabilityCall): number[] {
    return call.viewableItems.map((token) => token.index as number).sort((a, b) => a - b);
  }

  it('reports fully and partially visible items by itemVisiblePercentThreshold', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      viewabilityConfig: {itemVisiblePercentThreshold: 50},
      onViewableItemsChanged: spy as unknown as NitroListOnViewableItemsChanged<string>,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(spy).toHaveBeenCalled();
    const first = spy.mock.calls[0][0] as ViewabilityCall;
    expect(viewableIndices(first)).toEqual([0, 1, 2, 3, 4, 5]);

    spy.mockClear();
    harness.scroll(151);
    await harness.settle(50);
    expect(spy).toHaveBeenCalled();
    const afterScroll = spy.mock.calls[spy.mock.calls.length - 1][0] as ViewabilityCall;
    expect(viewableIndices(afterScroll)).toEqual([2, 3, 4, 5, 6, 7]);
    const changedTokens = (spy.mock.calls[spy.mock.calls.length - 1][0] as ViewabilityCall).changed;
    expect(changedTokens.some((token) => token.index === 0 && !token.isViewable)).toBe(true);
  });

  it('minimumViewTime holds items back until they stay visible long enough', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      viewabilityConfig: {itemVisiblePercentThreshold: 50, minimumViewTime: 500},
      onViewableItemsChanged: spy as unknown as NitroListOnViewableItemsChanged<string>,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    harness.frame(50);
    expect(spy).not.toHaveBeenCalled();

    harness.scroll(2000);
    harness.frame(100);
    harness.scroll(4000);
    await harness.settle(600);

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1][0] as ViewabilityCall;
    const reported = viewableIndices(lastCall);
    expect(reported[0]).toBeGreaterThanOrEqual(40);
    for (const call of spy.mock.calls) {
      for (const token of (call[0] as ViewabilityCall).changed) {
        if (token.isViewable) {
          expect(token.index).toBeGreaterThanOrEqual(40);
        }
      }
    }
  });

  it('waitForInteraction defers reporting until the first drag', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      viewabilityConfig: {itemVisiblePercentThreshold: 50, waitForInteraction: true},
      onViewableItemsChanged: spy as unknown as NitroListOnViewableItemsChanged<string>,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(100);
    expect(spy).not.toHaveBeenCalled();

    harness.beginDrag(0);
    await harness.settle(50);
    expect(spy).toHaveBeenCalled();
    const first = spy.mock.calls[0][0] as ViewabilityCall;
    expect(viewableIndices(first)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
