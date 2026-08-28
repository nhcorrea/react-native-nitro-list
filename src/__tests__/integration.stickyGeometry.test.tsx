import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {
  itemKey,
  makeItems,
  renderNitroList,
  webOnlyDependencyUsages,
  type NitroListHarness,
} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('sticky geometry', () => {
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

  it('honors contentContainerStyle paddingTop when resolving the active sticky', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      contentContainerStyle: {paddingTop: 100},
      stickyHeaderIndices: [0, 10],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    expect(stickyChanges).toEqual([]);

    harness.scroll(100);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    harness.scroll(1099);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);

    harness.scroll(1100);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
  });

  it('honors contentContainerStyle paddingVertical for the sticky bar', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      contentContainerStyle: {paddingVertical: 60},
      stickyHeaderIndices: [0, 10],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(1059);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    harness.scroll(1060);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
  });

  it('ignores paddingStart/paddingEnd on a vertical list (they are horizontal in RN)', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      contentContainerStyle: {paddingStart: 100},
      stickyHeaderIndices: [0, 10],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(1000);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
  });

  it('pushes the outgoing header off using the overlay size, not the cell size', async () => {
    const cellSize = (index: number) => (index === 0 || index === 5 ? 112 : 100);
    harness = renderNitroList({
      data: makeItems(12),
      renderItem: () => null,
      estimatedItemSize: 100,
      drawDistance: 5000,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 5],
      stickyHeaderConfig: {offset: 100},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(cellSize);
    await harness.settle(50);
    harness.measureUnmeasuredCells(cellSize);
    await harness.settle(50);
    harness.measureStickyOverlay(72);
    await harness.settle(50);
    harness.scroll(340);
    expect(harness.stickyTranslateY()).toBe(100);

    harness.scroll(360);
    expect(harness.stickyTranslateY()).toBe(80);
    harness.scroll(411);
    expect(harness.stickyTranslateY() + 72).toBe(512 - 411);

    harness.scroll(412);
    expect(harness.stickyTranslateY()).toBe(100);
  });

  it('accepts an explicit stickyHeaderConfig.size instead of measuring', async () => {
    const cellSize = (index: number) => (index === 0 || index === 5 ? 112 : 100);
    harness = renderNitroList({
      data: makeItems(12),
      renderItem: () => null,
      estimatedItemSize: 100,
      drawDistance: 5000,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 5],
      stickyHeaderConfig: {offset: 100, size: 72},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(cellSize);
    await harness.settle(50);
    harness.measureUnmeasuredCells(cellSize);
    await harness.settle(50);

    harness.scroll(340);
    expect(harness.stickyTranslateY()).toBe(100);
    harness.scroll(411);
    expect(harness.stickyTranslateY() + 72).toBe(512 - 411);
  });

  it('honors paddingStart on a horizontal list', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      horizontal: true,
      keyExtractor: itemKey,
      contentContainerStyle: {paddingStart: 100},
      stickyHeaderIndices: [0, 10],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(1099);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    harness.scroll(1100);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
  });

  it('never passes web-only dependency arrays to reanimated hooks', async () => {
    harness = renderNitroList({
      data: makeItems(60),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      contentContainerStyle: {paddingTop: 100},
      stickyHeaderIndices: [0, 10],
      stickyHeaderConfig: {offset: 40, hideRelatedCell: true},
      experimentalUiThreadScroll: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    harness.scroll(1200);
    await harness.settle(50);

    expect(webOnlyDependencyUsages()).toEqual([]);
  });
});
