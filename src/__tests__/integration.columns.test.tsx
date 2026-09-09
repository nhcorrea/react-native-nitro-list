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

    expect(harness.mirror.dataCommits.some(c => c[14] > 0)).toBe(true);
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

  it('getLayout reports slots with spans, cross padding and gaps in container coordinates', async () => {
    harness = renderNitroList({
      data: makeItems(12), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey,
      numColumns: 3, contentContainerStyle: {paddingHorizontal: 20, paddingTop: 30},
      columnWrapperStyle: {rowGap: 8, columnGap: 12},
      overrideItemLayout: (layout, _item, index) => { if (index === 0) layout.span = 2; },
    });
    harness.layout(400, 600);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    // Available width 360; slots 240 + 120. Column gap is padding inside slots.
    expect(harness.handle.getLayout(0)).toEqual({x: 0, y: 0, width: 240, height: 100});
    expect(harness.handle.getLayout(1)).toEqual({x: 240, y: 0, width: 120, height: 100});
    expect(harness.handle.getLayout(2)).toEqual({x: 0, y: 108, width: 120, height: 100});
    expect(harness.handle.getLayout(NaN)).toBeUndefined();
    expect(harness.handle.getLayout(1.5)).toBeUndefined();
  });

  it('explicit fixed heights include the row gap in the engine but not the cell rectangle', async () => {
    harness = renderNitroList({
      data: makeItems(12), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey,
      numColumns: 2, getFixedItemSize: () => 100, columnWrapperStyle: {rowGap: 8},
    });
    harness.layout(400, 600);
    await harness.settle(50);
    expect(harness.handle.getItemOffset(2)).toBe(108);
    expect(harness.handle.getLayout(2)).toEqual({x: 0, y: 108, width: 200, height: 100});
    harness.update({columnWrapperStyle: {rowGap: 16}});
    await harness.settle(50);
    expect(harness.handle.getLayout(2)).toEqual({x: 0, y: 116, width: 200, height: 100});
  });
});
