import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearMeasurementCache} from '../measurementCache';
import {loadUiThread} from '../uiThreadLoader';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {clearCreatedSharedValuesForTests, getCreatedSharedValuesForTests} from './helpers/mockReanimated';

jest.mock('../uiThreadLoader', () => {
  const actual = jest.requireActual<typeof import('../uiThreadLoader')>('../uiThreadLoader');
  return {loadUiThread: jest.fn(actual.loadUiThread)};
});

describe('ui-thread dependencies', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
    clearCreatedSharedValuesForTests();
    jest.mocked(loadUiThread).mockClear();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function scrollAround(list: NitroListHarness) {
    list.layout(400, 800);
    list.measureAllCells(() => 64);
    await list.settle(50);
    list.scroll(3000);
    list.measureUnmeasuredCells(() => 64);
    await list.settle(50);
    void list.handle.scrollToIndex({index: 200});
    await list.settle(500);
  }

  it('a list without sticky headers or the ui-thread driver never loads them', async () => {
    harness = renderNitroList({data: makeItems(500), renderItem: () => null, estimatedItemSize: 64, keyExtractor: itemKey});
    await scrollAround(harness);
    expect(loadUiThread).not.toHaveBeenCalled();
    expect(getCreatedSharedValuesForTests()).toHaveLength(0);
  });

  it('sticky headers load them on first use', async () => {
    harness = renderNitroList({data: makeItems(500), renderItem: () => null, estimatedItemSize: 64, keyExtractor: itemKey, stickyHeaderIndices: [0]});
    await scrollAround(harness);
    expect(loadUiThread).toHaveBeenCalled();
    expect(getCreatedSharedValuesForTests().length).toBeGreaterThan(0);
  });
});
