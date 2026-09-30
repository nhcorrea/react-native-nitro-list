import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {sharedValueWritesForTests} from './helpers/mockReanimated';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

function mountMeasured(props: Partial<Parameters<typeof renderNitroList<string>>[0]> = {}): NitroListHarness {
  const harness = renderNitroList<string>({
    data: makeItems(400),
    renderItem: () => null,
    estimatedItemSize: 100,
    keyExtractor: itemKey,
    ...props,
  });
  harness.layout(VIEWPORT_W, VIEWPORT_H);
  harness.measureAllCells(() => 100);
  harness.frame(32);
  harness.scroll(1000);
  harness.measureUnmeasuredCells(() => 100);
  harness.frame(32);
  return harness;
}

describe('scroll path churn (fronteira 1.8)', () => {
  let harness: NitroListHarness | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('writes no shared value per scroll event when the list has no sticky headers', () => {
    harness = mountMeasured();
    const before = sharedValueWritesForTests();
    for (let k = 1; k <= 60; k++) harness.scroll(1000 + k * 7);
    expect(sharedValueWritesForTests()).toBe(before);
  });

  it('keeps the position anchor without calling keyExtractor while the anchor item stays the same', () => {
    const keyExtractor = jest.fn(itemKey);
    harness = mountMeasured({keyExtractor});
    const callsFor = (item: string) => keyExtractor.mock.calls.filter(([arg]) => arg === item).length;
    harness.scroll(1003);
    keyExtractor.mockClear();
    for (let k = 1; k <= 30; k++) harness.scroll(1003 + k * 3);
    expect(callsFor('item-11')).toBe(0);
    harness.scroll(1205);
    expect(callsFor('item-13')).toBe(1);
  });

  it('re-arms the viewability timer only when the earliest deadline moves', () => {
    harness = mountMeasured({
      viewabilityConfig: {itemVisiblePercentThreshold: 50, minimumViewTime: 1000},
      onViewableItemsChanged: () => {},
    });
    harness.scroll(1003);
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    for (let k = 1; k <= 20; k++) harness.scroll(1003 + k * 4);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
