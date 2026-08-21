import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('imperative conveniences (T32)', () => {
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

  async function mount(): Promise<void> {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
  }

  it('scrollIndexIntoView is a no-op for visible items and aligns by direction otherwise', async () => {
    await mount();
    harness.scroll(1000);
    await harness.settle(50);

    const commandsBefore = harness.scrollCommands.length;
    await act(async () => {
      await harness.handle.scrollIndexIntoView({index: 12});
    });
    expect(harness.scrollCommands.length).toBe(commandsBefore);
    expect(harness.lastScrollTop()).toBe(1000);

    await act(async () => {
      const promise = harness.handle.scrollIndexIntoView({index: 30});
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    expect(harness.lastScrollTop()).toBeCloseTo(31 * 100 - VIEWPORT_H, 0);

    await act(async () => {
      const promise = harness.handle.scrollIndexIntoView({index: 3});
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    expect(harness.lastScrollTop()).toBeCloseTo(300, 0);
  });

  it('scrollItemIntoView resolves the index by identity', async () => {
    await mount();
    const items = makeItems(100);
    await act(async () => {
      const promise = harness.handle.scrollItemIntoView({item: items[40]});
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    expect(harness.lastScrollTop()).toBeCloseTo(41 * 100 - VIEWPORT_H, 0);
  });

  it('snapToIndices computes snapToOffsets from live core offsets', async () => {
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      snapToIndices: [0, 10, 20],
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    expect(harness.scrollProps.snapToOffsets).toEqual([0, 1000, 2000]);

    harness.measureAllCells(() => 150);
    await harness.settle(50);
    expect(harness.scrollProps.snapToOffsets?.[1]).toBeGreaterThan(1000);
  });
});
