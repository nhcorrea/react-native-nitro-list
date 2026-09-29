import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {nativeArrayBufferAllocationsForTests} from './helpers/mockNitroModules';

let harness: NitroListHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  harness?.unmount();
  harness = undefined;
  jest.useRealTimers();
});

describe('engine buffers (fronteira 1.2)', () => {
  it('passes only native buffers across scroll, measurement, data updates and reads', async () => {
    const data = makeItems(400);
    harness = renderNitroList({
      data,
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      getItemType: (item) => (item.endsWith('0') ? 'header' : 'row'),
      getFixedItemSize: (_item, index) => (index % 7 === 0 ? 40 : undefined),
      numColumns: 2,
      maintainVisibleContentPosition: {data: true},
      renderItem: () => null,
    });
    harness.layout(400, 3000);
    harness.measureAllCells((index) => 60 + (index % 3));
    await harness.settle(50);
    harness.scroll(800);
    harness.scroll(1600);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 61);
    await harness.settle(50);
    harness.update({data: [...makeItems(20, 1000), ...data]});
    await harness.settle(50);
    harness.handle.getAverageItemSizes();
    harness.handle.getLayout(390);

    const log = harness.mirror.callLog;
    for (const method of [
      'updateData',
      'setScrollOffsetAndFill',
      'setItemSizesAndFill',
      'fillLayoutSlab',
      'seedTypeMeans',
      'fillTypeStats',
    ]) {
      expect(log).toContain(method);
    }
    expect(harness.mirror.reads.layout).toBeGreaterThan(0);
    expect(harness.mirror.dataCommits.some((config) => config[13] > 0)).toBe(true);
    expect(harness.mirror.dataCommits.some((config) => config[14] > 0)).toBe(true);
    expect(harness.mirror.dataCommits.some((config) => config[12] > 0)).toBe(true);
    expect(harness.mirror.jsBuffers).toEqual([]);
  });

  it('retries an oversized snapshot through readSnapshot with native buffers', async () => {
    harness = renderNitroList({
      data: makeItems(2000),
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      renderItem: () => null,
    });
    harness.layout(400, 1000);
    await harness.settle(50);
    harness.measureAllCells(() => 1);
    await harness.settle(50);
    expect(harness.mirror.callLog).toContain('readSnapshot');
    expect(harness.mirror.jsBuffers).toEqual([]);
  });

  it('does not allocate buffers per scroll event once the window is warm', async () => {
    harness = renderNitroList({
      data: makeItems(2000),
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      renderItem: () => null,
    });
    harness.layout(400, 800);
    harness.measureAllCells(() => 50);
    await harness.settle(50);
    for (let y = 0; y < 2000; y += 20) harness.scroll(y);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 50);
    await harness.settle(50);
    const before = nativeArrayBufferAllocationsForTests();
    const eventsBefore = harness.mirror.callLog.filter((c) => c === 'setScrollOffsetAndFill').length;
    for (let y = 0; y < 20000; y += 20) harness.scroll(y);
    await harness.settle(50);
    const events =
      harness.mirror.callLog.filter((c) => c === 'setScrollOffsetAndFill').length - eventsBefore;
    expect(events).toBeGreaterThan(500);
    expect(nativeArrayBufferAllocationsForTests() - before).toBe(0);
  });
});
