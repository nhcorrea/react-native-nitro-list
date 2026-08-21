import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('public observability integration (T19)', () => {
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

  it('onLoad reports elapsed time since mount, once', async () => {
    const onLoad = jest.fn();
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      onLoad: onLoad as (info: {elapsedTimeInMs: number}) => void,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);

    expect(onLoad).toHaveBeenCalledTimes(1);
    const info = onLoad.mock.calls[0][0] as {elapsedTimeInMs: number};
    expect(typeof info.elapsedTimeInMs).toBe('number');
    expect(info.elapsedTimeInMs).toBeGreaterThanOrEqual(0);

    harness.scroll(500);
    await harness.settle(50);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('onFirstVisibleItemChanged fires on transitions and dedupes by index', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      onFirstVisibleItemChanged: spy as (info: {
        index: number;
        item: string;
        key: string;
      }) => void,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toEqual({index: 0, item: 'item-0', key: 'item-0'});

    const callsBefore = spy.mock.calls.length;
    harness.scroll(50);
    expect(spy.mock.calls.length).toBe(callsBefore);

    harness.scroll(350);
    const last = spy.mock.calls[spy.mock.calls.length - 1][0] as {index: number; key: string};
    expect(last).toEqual({index: 3, item: 'item-3', key: 'item-3'});
  });

  it('onItemSizeChanged relays every flushed measurement', async () => {
    const spy = jest.fn();
    harness = renderNitroList({
      data: makeItems(30),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      onItemSizeChanged: spy as (info: {index: number; size: number}) => void,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureCell(0, 140);
    harness.measureCell(1, 90);
    harness.frame();

    const reported = spy.mock.calls.map((call) => call[0]);
    expect(reported).toContainEqual({index: 0, size: 140});
    expect(reported).toContainEqual({index: 1, size: 90});
  });

  it('getAverageItemSizes exposes per-type means keyed by the user type', async () => {
    harness = renderNitroList<string>({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      getItemType: (item) => (Number(item.slice('item-'.length)) % 2 === 0 ? 'even' : 'odd'),
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells((index) => (index % 2 === 0 ? 120 : 80));
    await harness.settle(50);

    const averages = harness.handle.getAverageItemSizes();
    expect(averages.even).toBeDefined();
    expect(averages.odd).toBeDefined();
    expect(averages.even.average).toBeCloseTo(120, 3);
    expect(averages.odd.average).toBeCloseTo(80, 3);
    expect(averages.even.count).toBeGreaterThan(0);
    expect(averages.odd.count).toBeGreaterThan(0);
  });

  it('getAverageItemSizes buckets untyped lists under the empty key', async () => {
    harness = renderNitroList({
      data: makeItems(40),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 110);
    await harness.settle(50);

    const averages = harness.handle.getAverageItemSizes();
    expect(averages['']).toBeDefined();
    expect(averages[''].average).toBeCloseTo(110, 3);
  });
});
