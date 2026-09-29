import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const extent = (index: number) => 40 + (index % 3) * 10;
const extentOfKey = (item: string) => extent(Number(item.slice('item-'.length)));

describe('cold layout reads', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    jest.useRealTimers();
  });

  const resetReads = () => Object.assign(harness!.mirror.reads, {offset: 0, size: 0, layout: 0, layoutItems: 0});

  it.each([false, true])('getLayout of a cold item costs one engine read (horizontal: %s)', async (horizontal) => {
    harness = renderNitroList({
      data: makeItems(5000),
      renderItem: () => null,
      estimatedItemSize: 45,
      keyExtractor: itemKey,
      horizontal,
      getFixedItemSize: extentOfKey,
    });
    harness.layout(400, 800);
    await harness.settle(50);
    let start = 0;
    for (let i = 0; i < 3000; i++) start += extent(i);
    const expected = horizontal
      ? {x: start, y: 0, width: extent(3000), height: 800}
      : {x: 0, y: start, width: 400, height: extent(3000)};
    resetReads();
    expect(harness.handle.getLayout(3000)).toEqual(expected);
    expect(harness.mirror.reads).toEqual({offset: 0, size: 0, layout: 1, layoutItems: 1});
    expect(harness.handle.getLayout(3000)).toEqual(expected);
    expect(harness.mirror.reads.layout).toBe(1);
  });

  it('grid getLayout matches an independent packing with one read per cold item', async () => {
    const span = (index: number) => (index % 4 === 0 ? 3 : 1);
    harness = renderNitroList({
      data: makeItems(2000),
      renderItem: () => null,
      estimatedItemSize: 60,
      keyExtractor: itemKey,
      numColumns: 3,
      getFixedItemSize: () => 60,
      overrideItemLayout: (layout, _item, index) => {
        layout.span = span(index);
      },
      columnWrapperStyle: {rowGap: 8},
    });
    harness.layout(300, 600);
    await harness.settle(50);
    const cells: Array<{x: number; y: number; width: number}> = [];
    let used = 0;
    let top = 0;
    for (let i = 0; i < 2000; i++) {
      const s = span(i);
      if (used > 0 && used + s > 3) {
        top += 68;
        used = 0;
      }
      cells.push({x: used * 100, y: top, width: s * 100});
      used += s;
      if (used >= 3) {
        top += 68;
        used = 0;
      }
    }
    resetReads();
    for (const index of [1501, 1600, 1999]) {
      expect(harness.handle.getLayout(index)).toEqual({...cells[index], height: 60});
    }
    expect(harness.mirror.reads.offset + harness.mirror.reads.size).toBe(0);
    expect(harness.mirror.reads.layout).toBe(3);
  });

  it('mounts an old anchored tail with batched reads instead of one read per cell', async () => {
    harness = renderNitroList({data: makeItems(300), renderItem: () => null, estimatedItemSize: 50, keyExtractor: itemKey});
    harness.layout(400, 800);
    harness.measureAllCells(() => 60);
    await harness.settle(50);
    resetReads();
    harness.update({anchoredEndSpace: {anchorIndex: 260}});
    await harness.settle(50);
    expect(harness.renderedIndices()).toEqual(expect.arrayContaining(Array.from({length: 40}, (_, k) => 260 + k)));
    expect(harness.mirror.reads.offset + harness.mirror.reads.size).toBe(0);
    expect(harness.mirror.reads.layout).toBeLessThanOrEqual(2);
  });

  it('scrollToIndex reaches 95k, returns and survives a shrink in the same instance', async () => {
    harness = renderNitroList({data: makeItems(100_000), renderItem: () => null, estimatedItemSize: 50, keyExtractor: itemKey});
    harness.layout(400, 800);
    harness.measureAllCells(() => 60);
    await harness.settle(50);
    const go = async (index: number) => {
      let done = false;
      act(() => {
        harness!.handle.scrollToIndex({index}).then(() => {
          done = true;
        });
      });
      for (let i = 0; i < 30 && !done; i++) {
        harness!.measureAllCells(() => 60);
        await harness!.settle(20);
      }
      expect(done).toBe(true);
    };
    await go(95_000);
    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getFirstItemOffset() + harness.handle.getItemOffset(95_000), 3);
    expect(harness.handle.getLayout(95_000)).toMatchObject({y: harness.handle.getItemOffset(95_000), height: 60});
    await go(0);
    expect(harness.lastScrollTop()).toBeCloseTo(0, 3);
    harness.update({data: makeItems(100)});
    await harness.settle(50);
    expect(harness.handle.getLayout(99)).toBeDefined();
    expect(harness.handle.getLayout(100)).toBeUndefined();
    expect(harness.handle.getLayout(95_000)).toBeUndefined();
  });
});
