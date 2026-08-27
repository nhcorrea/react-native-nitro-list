import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('numColumns grid (T30)', () => {
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

  it('lays rows out sharing an offset, advancing by the tallest member', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      numColumns: 2,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);

    expect(harness.handle.getItemOffset(0)).toBe(0);
    expect(harness.handle.getItemOffset(1)).toBe(0);
    expect(harness.handle.getItemOffset(2)).toBe(100);
    expect(harness.handle.getTotalSize()).toBe(10 * 100);

    harness.measureCell(2, 180);
    harness.measureCell(3, 90);
    await harness.settle(50);
    expect(harness.handle.getItemOffset(3)).toBe(harness.handle.getItemOffset(2));
    expect(harness.handle.getItemOffset(4) - harness.handle.getItemOffset(2)).toBe(180);

    const cells = harness.cellInstances();
    expect(cells.get(0)?.props.columnLeft).toBe('0%');
    expect(cells.get(1)?.props.columnLeft).toBe('50%');
    expect(cells.get(1)?.props.columnWidth).toBe('50%');
  });

  it('overrideItemLayout spans give an item its own full-width row', async () => {
    harness = renderNitroList({
      data: makeItems(10),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      numColumns: 2,
      overrideItemLayout: (layout, _item, index) => {
        if (index === 0) layout.span = 2;
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);

    expect(harness.mirror.callLog).toContain('setItemSpans');
    expect(harness.handle.getItemOffset(0)).toBe(0);
    expect(harness.handle.getItemOffset(1)).toBe(100);
    expect(harness.handle.getItemOffset(2)).toBe(100);
    expect(harness.handle.getItemOffset(3)).toBe(200);
    const cells = harness.cellInstances();
    expect(cells.get(0)?.props.columnWidth).toBe('100%');
    expect(cells.get(1)?.props.columnWidth).toBe('50%');
  });

  it('folds the rowGap into reported sizes', async () => {
    harness = renderNitroList({
      data: makeItems(12),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      numColumns: 2,
      columnWrapperStyle: {rowGap: 8, columnGap: 12},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(harness.handle.getItemSize(0)).toBe(108);
    const cell = harness.cellInstances().get(0);
    expect(cell).toBeDefined();
  });

  it('changing numColumns drops measurements back to estimates', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      numColumns: 2,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 150);
    await harness.settle(50);
    expect(harness.handle.getItemSize(0)).toBe(150);

    harness.update({numColumns: 3});
    await harness.settle(50);
    expect(harness.handle.getItemSize(0)).toBe(100);
    expect(harness.handle.getItemOffset(3)).toBe(100);
  });

  it('ranges always cover whole rows', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      numColumns: 2,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    harness.scroll(3000);
    const indices = harness.renderedIndices();
    expect(indices[0] % 2).toBe(0);
    expect((indices[indices.length - 1] + 1) % 2).toBe(0);
  });
});
