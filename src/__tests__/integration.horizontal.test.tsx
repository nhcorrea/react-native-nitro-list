import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_MAIN = 600;
const VIEWPORT_CROSS = 400;

describe('horizontal axis (T29)', () => {
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

  it('ranges, measures widths and scrolls along x', async () => {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      horizontal: true,
    });
    expect(harness.scrollProps.horizontal).toBe(true);

    harness.layout(VIEWPORT_MAIN, VIEWPORT_CROSS);
    harness.frame();
    const expanded = harness.renderedIndices();
    expect(expanded[expanded.length - 1]).toBe(8);

    harness.measureAllCells(() => 150);
    harness.frame();
    expect(harness.handle.getItemSize(0)).toBe(150);
    expect(harness.handle.getTotalSize()).toBe(100 * 150);

    harness.scroll(3000);
    expect(harness.renderedIndices()[0]).toBeGreaterThan(0);
    expect(harness.lastScrollTop()).toBe(3000);

    const layout = harness.handle.getLayout(3);
    expect(layout).toEqual({x: 450, y: 0, width: 150, height: VIEWPORT_CROSS});
  });

  it('scrollToIndex converges along x with under-estimated widths', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      horizontal: true,
    });
    harness.layout(VIEWPORT_MAIN, VIEWPORT_CROSS);
    for (let round = 0; round < 3; round++) {
      harness.measureAllCells(() => 130);
      await harness.settle(50);
    }

    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToIndex({index: 100});
    });
    for (let round = 0; round < 20; round++) {
      harness.measureAllCells(() => 130);
      await harness.settle(50);
    }
    await promise;

    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(100), 0);
    expect(harness.scrollCommands[harness.scrollCommands.length - 1].y).toBeCloseTo(
      harness.handle.getItemOffset(100),
      0,
    );
  });

  it('sticky headers activate and push off with translateX', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      horizontal: true,
      stickyHeaderIndices: [0, 10],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_MAIN, VIEWPORT_CROSS);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(950);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    expect(harness.stickyTranslateY()).toBe(-50);

    harness.scroll(1050);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
    expect(harness.stickyTranslateY()).toBe(0);
  });

  it('edges fire from x distances and horizontal padding shifts the first item offset', async () => {
    const onEndReached = jest.fn();
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      horizontal: true,
      onEndReached: onEndReached as (info: {distanceFromEnd: number}) => void,
      onEndReachedThreshold: 0.5,
      contentContainerStyle: {paddingLeft: 40, paddingRight: 20},
    });
    harness.layout(VIEWPORT_MAIN, VIEWPORT_CROSS);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(harness.handle.getFirstItemOffset()).toBe(40);

    harness.scroll(1200);
    expect(onEndReached).toHaveBeenCalledTimes(1);
    expect(onEndReached.mock.calls[0][0]).toEqual({
      distanceFromEnd: 40 + 2000 + 20 - 1200 - VIEWPORT_MAIN,
    });
  });
});
