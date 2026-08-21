import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('anchoredEndSpace (T22)', () => {
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

  it('pads the tail so the anchor can pin to the viewport top, and growth eats the pad', async () => {
    const sizeChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      anchoredEndSpace: {
        anchorIndex: 18,
        onSizeChanged: (size) => {
          sizeChanges.push(size);
        },
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(harness.renderedIndices()).toContain(18);
    expect(harness.renderedIndices()).toContain(19);
    expect(sizeChanges[sizeChanges.length - 1]).toBe(400);

    let landing = 0;
    await act(async () => {
      const promise = harness.handle.scrollToEnd(false);
      await jest.advanceTimersByTimeAsync(1000);
      await promise;
      landing = harness.lastScrollTop();
    });
    expect(landing).toBeCloseTo(1800, 0);
    expect(harness.handle.getItemOffset(18)).toBe(1800);

    harness.measureCell(19, 250);
    await harness.settle(50);
    expect(sizeChanges[sizeChanges.length - 1]).toBe(250);
    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(18), 0);
  });

  it('caps the anchor contribution with anchorMaxSize', async () => {
    const sizeChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      anchoredEndSpace: {
        anchorIndex: 19,
        anchorMaxSize: 120,
        onSizeChanged: (size) => {
          sizeChanges.push(size);
        },
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells((index) => (index === 19 ? 400 : 100));
    await harness.settle(50);

    expect(sizeChanges[sizeChanges.length - 1]).toBe(VIEWPORT_H - 120);
  });

  it('fires onReady once the whole tail has authoritative sizes', async () => {
    const onReady = jest.fn();
    harness = renderNitroList({
      data: makeItems(40),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      anchoredEndSpace: {anchorIndex: 36, onReady: onReady as () => void},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    expect(onReady).not.toHaveBeenCalled();

    harness.measureAllCells(() => 100);
    await harness.settle(50);
    expect(onReady).toHaveBeenCalledTimes(1);

    harness.measureCell(37, 130);
    await harness.settle(50);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('wins over maintainScrollAtEnd while active', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
      anchoredEndSpace: {anchorIndex: 18},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    harness.scroll(1700);
    await harness.settle(50);

    harness.update({data: makeItems(24), anchoredEndSpace: {anchorIndex: 18}});
    harness.measureAllCells(() => 100);
    await harness.settle(200);
    expect(harness.lastScrollTop()).toBe(1700);
  });
});
