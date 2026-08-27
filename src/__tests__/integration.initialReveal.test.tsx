import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('initial scroll reveal gate (T26)', () => {
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

  async function drive(
    heightForIndex: (index: number) => number,
    rounds: number,
    stepMs: number = 50,
  ): Promise<void> {
    for (let r = 0; r < rounds; r++) {
      harness.measureAllCells(heightForIndex);
      await harness.settle(stepMs);
    }
  }

  it('hides the list until the initial index converges, then reveals', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollIndex: 50,
    });
    expect(harness.wrapperOpacity()).toBe(0);

    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 130, 20);

    expect(harness.wrapperOpacity()).not.toBe(0);
    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(50), 0);
  });

  it('initialScrollAtEnd converges to the true end with under-estimated items', async () => {
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollAtEnd: true,
    });
    expect(harness.scrollProps.contentOffset?.y).toBe(5000);
    expect(harness.wrapperOpacity()).toBe(0);

    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 150, 25);

    expect(harness.wrapperOpacity()).not.toBe(0);
    expect(harness.lastScrollTop()).toBeCloseTo(50 * 150 - VIEWPORT_H, 0);
  });

  it('re-targets an end-aligned initial scroll when the footer grows before settle', async () => {
    harness = renderNitroList({
      data: makeItems(50),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollAtEnd: true,
      ListFooterComponent: () => null,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.layoutFooter(90);
    await drive(() => 150, 25);

    expect(harness.lastScrollTop()).toBeCloseTo(50 * 150 + 90 - VIEWPORT_H, 0);
  });

  it('always reveals even when the initial target can never converge', async () => {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollIndex: 500,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    expect(harness.wrapperOpacity()).toBe(0);
    await harness.settle(1600);
    expect(harness.wrapperOpacity()).not.toBe(0);
  });
});
