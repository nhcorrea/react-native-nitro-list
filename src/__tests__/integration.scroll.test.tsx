import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('imperative scroll integration', () => {
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
    rounds: number = 20,
    stepMs: number = 50,
  ): Promise<void> {
    for (let r = 0; r < rounds; r++) {
      harness.measureAllCells(heightForIndex);
      await harness.settle(stepMs);
    }
  }

  it('scrollToIndex converges onto under-estimated items and freezes estimates meanwhile', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 130, 3);

    let promise!: Promise<void>;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      promise = harness.handle.scrollToIndex({index: 100});
    });
    await drive(() => 130, 25);
    await promise;

    expect(harness.mirror.callLog).toContain('setEstimatesFrozen:true');
    expect(harness.mirror.callLog).toContain('setEstimatesFrozen:false');
    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(100), 0);
    expect(harness.handle.getItemSize(100)).toBe(130);
    const indices = harness.renderedIndices();
    expect(indices).toContain(100);
  });

  it('a user drag supersedes an in-flight scrollToIndex', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 130, 2);

    let promise!: Promise<void>;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      promise = harness.handle.scrollToIndex({index: 150});
    });
    await harness.settle(20);
    harness.beginDrag();
    harness.scroll(400);
    harness.endDrag(400);
    const commandsAtDrag = harness.scrollCommands.length;
    await drive(() => 130, 10);
    await promise;

    expect(harness.scrollCommands.length).toBe(commandsAtDrag);
    expect(harness.lastScrollTop()).toBe(400);
  });

  it('scrollToEnd lands exactly at the end with a 50% under-estimated tail (T4)', async () => {
    harness = renderNitroList({
      data: makeItems(120),
      renderItem: () => null,
      estimatedItemSize: 75,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 150, 3);

    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      harness.handle.scrollToEnd(false);
    });
    await drive(() => 150, 25);

    const lastBottom = harness.handle.getItemOffset(119) + harness.handle.getItemSize(119);
    expect(harness.handle.getItemSize(119)).toBe(150);
    expect(harness.lastScrollTop()).toBeCloseTo(lastBottom - VIEWPORT_H, 0);
  });

  it('initialScrollIndex seeds contentOffset from the estimate and settles on the item', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollIndex: 50,
    });

    expect(harness.scrollProps.contentOffset?.y).toBe(5000);

    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 25);

    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(50), 0);
    expect(harness.renderedIndices()).toContain(50);
    expect(harness.mirror.callLog).toContain('setEstimatesFrozen:true');
  });

  it('initialScrollOffset scrolls to the exact offset without index convergence', async () => {
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      initialScrollOffset: 3210,
    });

    expect(harness.scrollProps.contentOffset?.y).toBe(3210);

    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 6);

    expect(harness.lastScrollTop()).toBe(3210);
    const indices = harness.renderedIndices();
    expect(indices).toContain(32);
  });

  it('footer growth (typing indicator) triggers maintainScrollAtEnd (T23)', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
      ListFooterComponent: () => null,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 3);
    harness.scroll(1400);

    harness.layoutFooter(80);
    await drive(() => 100, 12);
    expect(harness.lastScrollTop()).toBeCloseTo(20 * 100 + 80 - VIEWPORT_H, 0);
  });

  it('a drag begun during a pending stick cancels it (T23)', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 3);
    harness.scroll(1400);

    harness.update({data: makeItems(22)});
    harness.beginDrag(1400);
    harness.scroll(700);
    harness.endDrag(700);
    await drive(() => 100, 10);
    expect(harness.lastScrollTop()).toBe(700);
  });

  it('growth during an in-flight stick coalesces into a re-stick (T23)', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 3);
    harness.scroll(1400);

    harness.update({data: makeItems(22)});
    await harness.settle(20);
    harness.update({data: makeItems(30)});
    await drive(() => 100, 25);
    expect(harness.lastScrollTop()).toBeCloseTo(30 * 100 - VIEWPORT_H, 0);
  });

  it('maintainScrollAtEnd re-sticks after growth and respects an active drag', async () => {
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await drive(() => 100, 3);

    harness.scroll(1400);
    expect(harness.lastScrollTop()).toBe(1400);

    harness.update({data: makeItems(21)});
    await drive(() => 100, 15);
    expect(harness.lastScrollTop()).toBeCloseTo(21 * 100 - VIEWPORT_H, 0);

    harness.beginDrag();
    harness.scroll(900);
    harness.update({data: makeItems(25)});
    await drive(() => 100, 10);
    expect(harness.lastScrollTop()).toBe(900);
  });
});
