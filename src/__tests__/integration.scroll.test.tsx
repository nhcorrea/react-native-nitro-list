import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {useEffect} from 'react';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListRenderItem} from '../NitroList';
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

  it('animated scrollToOffset mounts each cell at most once and never remounts the origin', async () => {
    const mounts = new Map<number, number>();
    const unmounts = new Map<number, number>();
    const Cell = ({index}: {index: number}) => {
      useEffect(() => {
        mounts.set(index, (mounts.get(index) ?? 0) + 1);
        return () => {
          unmounts.set(index, (unmounts.get(index) ?? 0) + 1);
        };
      }, [index]);
      return null;
    };
    const renderItem: NitroListRenderItem<string> = ({index, target}) =>
      target === 'Cell' ? <Cell index={index} /> : null;
    harness = renderNitroList({
      data: makeItems(200),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    const originIndices = harness.renderedIndices();
    const mountsBefore = new Map(mounts);
    const unmountsBefore = new Map(unmounts);
    harness.animatedScrollFrames = 4;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      harness.handle.scrollToOffset({offset: 3000, animated: true});
    });
    await harness.settleAnimatedScroll();

    expect(harness.lastScrollTop()).toBe(3000);
    expect(harness.renderedIndices()).toContain(30);
    expect(harness.renderedIndices()).toContain(35);
    expect(harness.renderedIndices()).not.toContain(0);

    let newMounts = 0;
    const newlyMounted = new Set<number>();
    for (const [index, count] of mounts) {
      const delta = count - (mountsBefore.get(index) ?? 0);
      expect(delta).toBeLessThanOrEqual(1);
      newMounts += delta;
      if (delta > 0) newlyMounted.add(index);
    }
    expect(newMounts).toBe(newlyMounted.size);
    for (const index of originIndices) {
      expect(mounts.get(index)).toBe(mountsBefore.get(index));
      expect((unmounts.get(index) ?? 0) - (unmountsBefore.get(index) ?? 0)).toBe(1);
    }
    for (const index of newlyMounted) {
      expect(originIndices).not.toContain(index);
    }
  });

  function trackCellLifecycle(): {
    mounts: Map<number, number>;
    unmounts: Map<number, number>;
    renderItem: NitroListRenderItem<string>;
  } {
    const mounts = new Map<number, number>();
    const unmounts = new Map<number, number>();
    const Cell = ({index}: {index: number}) => {
      useEffect(() => {
        mounts.set(index, (mounts.get(index) ?? 0) + 1);
        return () => {
          unmounts.set(index, (unmounts.get(index) ?? 0) + 1);
        };
      }, [index]);
      return null;
    };
    const renderItem: NitroListRenderItem<string> = ({index, target}) =>
      target === 'Cell' ? <Cell index={index} /> : null;
    return {mounts, unmounts, renderItem};
  }

  it('a long animated scrollToOffset keeps only origin and destination mounted while flying over content', async () => {
    const {mounts, unmounts, renderItem} = trackCellLifecycle();
    harness = renderNitroList({
      data: makeItems(400),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    const origin = harness.renderedIndices();
    const mountsBefore = new Map(mounts);
    harness.animatedScrollFrames = 6;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      harness.handle.scrollToOffset({offset: 20000, animated: true});
    });
    const destination = harness.renderedIndices().filter((index) => !origin.includes(index));
    expect(destination).toContain(200);
    expect(destination).toContain(205);
    const allowed = new Set([...origin, ...destination]);

    for (let k = 0; k < harness.animatedScrollFrames; k++) {
      await harness.settle(harness.animatedScrollFrameMs);
      const inFlight = harness.renderedIndices();
      expect(inFlight.every((index) => allowed.has(index))).toBe(true);
      expect(inFlight).toEqual(expect.arrayContaining(origin));
      expect(inFlight).toEqual(expect.arrayContaining(destination));
    }
    expect(harness.lastScrollTop()).toBe(20000);
    await harness.settle(harness.animatedScrollFrameMs);

    const final = harness.renderedIndices();
    expect(final).toEqual(destination);
    for (let index = Math.max(...origin) + 1; index < Math.min(...destination); index++) {
      expect(mounts.has(index)).toBe(false);
    }
    for (const index of origin) {
      expect(mounts.get(index)).toBe(mountsBefore.get(index));
      expect(unmounts.get(index)).toBe(1);
    }
    for (const index of destination) {
      expect(mounts.get(index)).toBe(1);
      expect(unmounts.has(index)).toBe(false);
    }
  });

  it('animated scrollToIndex to a far row does not mount the rows it flies over', async () => {
    const {mounts, renderItem} = trackCellLifecycle();
    harness = renderNitroList({
      data: makeItems(400),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    const origin = harness.renderedIndices();
    harness.animatedScrollFrames = 6;
    let promise!: Promise<void>;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      promise = harness.handle.scrollToIndex({index: 250, animated: true});
    });
    await harness.settleAnimatedScroll();
    await harness.settle(400);
    await promise;

    expect(harness.lastScrollTop()).toBe(25000);
    const final = harness.renderedIndices();
    expect(final).toContain(250);
    expect(final).not.toContain(0);
    for (let index = Math.max(...origin) + 1; index < 240; index++) {
      expect(mounts.has(index)).toBe(false);
    }
  });

  it('a drag that interrupts an animated scrollToOffset commits the range under the finger', async () => {
    harness = renderNitroList({
      data: makeItems(400),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.animatedScrollFrames = 6;
    const {act} = require('react-test-renderer') as typeof import('react-test-renderer');
    act(() => {
      harness.handle.scrollToOffset({offset: 20000, animated: true});
    });
    for (let k = 0; k < 3; k++) {
      await harness.settle(harness.animatedScrollFrameMs);
    }
    expect(harness.lastScrollTop()).toBe(10000);
    expect(harness.renderedIndices()).not.toContain(100);

    harness.beginDrag(10000);
    expect(harness.renderedIndices()).toContain(100);
    expect(harness.renderedIndices()).toContain(105);
    expect(harness.renderedIndices()).not.toContain(0);
    expect(harness.renderedIndices()).not.toContain(200);
  });

  it('a touch scroll still commits every intermediate range', async () => {
    harness = renderNitroList({
      data: makeItems(400),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.beginDrag(0);
    harness.scroll(3000);
    expect(harness.renderedIndices()).toContain(30);
    expect(harness.renderedIndices()).toContain(35);
    harness.scroll(6000);
    expect(harness.renderedIndices()).toContain(60);
    expect(harness.renderedIndices()).not.toContain(30);
    harness.endDrag(6000);
    harness.momentumBegin(6000);
    harness.scroll(9000);
    expect(harness.renderedIndices()).toContain(90);
    harness.momentumEnd(9000);
    expect(harness.renderedIndices()).toContain(90);
    expect(harness.renderedIndices()).not.toContain(60);
    expect(harness.lastScrollTop()).toBe(9000);
  });

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
