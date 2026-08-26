import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {PixelRatio} from 'react-native';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {NitroListDevFlags} from '../devFlags';
import {clearMeasurementCache, measurementCacheKey, recordMeasurement} from '../measurementCache';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {PREWARM_ADMISSION_BUDGET_ITEMS} from '../prewarmAdmission';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

const {act} = require('react-test-renderer') as typeof import('react-test-renderer');

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function pseudoHeight(index: number): number {
  return 40 + (((index * 2654435761) >>> 0) % 161);
}

function countCalls(log: string[], name: string): number {
  let n = 0;
  for (const entry of log) if (entry === name) n++;
  return n;
}

describe('optimization cycle 2026-08 (O1–O3)', () => {
  let harness: NitroListHarness | null = null;
  let warnSpy: ReturnType<typeof jest.spyOn>;
  const flagsBefore = {...NitroListDevFlags};

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    Object.assign(NitroListDevFlags, flagsBefore);
    NitroListPerfMonitor.disable();
    clearMeasurementCache();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  describe('O1.4a — programmatic scroll echo guard', () => {
    async function scrollAndEcho(): Promise<number> {
      harness = renderNitroList({
        data: makeItems(200),
        renderItem: () => null,
        estimatedItemSize: 100,
        keyExtractor: itemKey,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      const before = countCalls(harness.mirror.callLog, 'setScrollOffsetAndFill');
      act(() => {
        void harness!.handle.scrollToOffset({offset: 1000});
      });
      await harness.settle(20);
      return countCalls(harness.mirror.callLog, 'setScrollOffsetAndFill') - before;
    }

    it('skips the engine push for the onScroll echo of an offset we just pushed', async () => {
      expect(await scrollAndEcho()).toBe(1);
      const list = harness!;
      const before = countCalls(list.mirror.callLog, 'setScrollOffsetAndFill');
      list.scroll(1100);
      expect(countCalls(list.mirror.callLog, 'setScrollOffsetAndFill') - before).toBe(1);
      expect(list.lastScrollTop()).toBe(1100);
    });

    it('pushes twice with the guard disabled (baseline behaviour)', async () => {
      NitroListDevFlags.scrollEchoGuard = false;
      expect(await scrollAndEcho()).toBe(2);
    });
  });

  describe("O2.2' — stale asynchronous range events", () => {
    async function deliverStaleEvent(): Promise<{atB: number[]; afterEvent: number[]}> {
      harness = renderNitroList(
        {
          data: makeItems(200),
          renderItem: () => null,
          estimatedItemSize: 100,
          keyExtractor: itemKey,
        },
        {asyncRangeDelivery: true},
      );
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      expect(harness.renderedIndices()).toContain(0);

      harness.measureCell(2, 150);
      act(() => {
        jest.runOnlyPendingTimers();
      });
      harness.scroll(2000);
      const atB = harness.renderedIndices();
      expect(atB).not.toContain(0);

      act(() => {
        jest.runOnlyPendingTimers();
      });
      return {atB, afterEvent: harness.renderedIndices()};
    }

    it('re-reads the engine instead of applying a range computed for an older offset', async () => {
      const {atB, afterEvent} = await deliverStaleEvent();
      expect(afterEvent).toEqual(atB);
      expect(harness!.handle.getItemSize(2)).toBe(150);
    });

    it('reverts to the stale range when the reconcile is disabled (baseline behaviour)', async () => {
      NitroListDevFlags.staleRangeReconcile = false;
      const {atB, afterEvent} = await deliverStaleEvent();
      expect(afterEvent).toContain(0);
      expect(afterEvent).not.toEqual(atB);
    });
  });

  describe('O2.3 — range edge hysteresis', () => {
    async function retreatAtBottomEdge(): Promise<{before: number[]; after: number[]}> {
      harness = renderNitroList({
        data: makeItems(200),
        renderItem: () => null,
        estimatedItemSize: 100,
        keyExtractor: itemKey,
        maintainVisibleContentPosition: false,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      harness.scroll(500);
      harness.scroll(1000);
      harness.measureAllCells(() => 100);
      harness.frame();
      await harness.settle(20);
      const before = harness.renderedIndices();
      harness.measureCell(8, 250);
      harness.frame();
      await harness.settle(20);
      return {before, after: harness.renderedIndices()};
    }

    it('keeps the leading-edge cells mounted when a measurement pushes them just past the window', async () => {
      const {before, after} = await retreatAtBottomEdge();
      const lastBefore = before[before.length - 1];
      expect(after).toContain(lastBefore);
      expect(harness!.handle.getItemSize(8)).toBe(250);
    });

    it('unmounts them without hysteresis (baseline behaviour)', async () => {
      NitroListDevFlags.rangeEdgeHysteresis = false;
      const {before, after} = await retreatAtBottomEdge();
      const lastBefore = before[before.length - 1];
      expect(after).not.toContain(lastBefore);
    });

    it('still lets the trailing edge unmount while scrolling forward', async () => {
      await retreatAtBottomEdge();
      const list = harness!;
      list.scroll(1600);
      list.scroll(2200);
      const rendered = list.renderedIndices();
      expect(rendered[0]).toBeGreaterThan(8);
      expect(rendered).toContain(22);
    });
  });

  describe('O3.1 — budgeted admission on the scrollToIndex landing', () => {
    async function jumpWithSlices(): Promise<number[]> {
      harness = renderNitroList({
        data: makeItems(400),
        renderItem: () => null,
        estimatedItemSize: 20,
        keyExtractor: itemKey,
        drawDistance: 250,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      const liveCount = harness.renderedIndices().length;
      expect(liveCount).toBeGreaterThan(PREWARM_ADMISSION_BUDGET_ITEMS);

      act(() => {
        void harness!.handle.scrollToIndex({index: 300, viewPosition: 0.5});
      });
      await flushMicrotasks();
      const growth: number[] = [];
      let previous = liveCount;
      for (let step = 0; step < 12; step++) {
        const count = harness.renderedIndices().length;
        if (count !== previous) {
          growth.push(count - previous);
          previous = count;
        }
        act(() => {
          jest.runOnlyPendingTimers();
        });
        await flushMicrotasks();
      }
      return growth;
    }

    it('mounts the destination window in slices of at most the admission budget', async () => {
      const growth = await jumpWithSlices();
      expect(growth.length).toBeGreaterThan(1);
      for (const delta of growth) expect(delta).toBeLessThanOrEqual(PREWARM_ADMISSION_BUDGET_ITEMS);
      expect(harness!.renderedIndices()).toContain(300);
    });

    it('mounts the whole window at once without admission (baseline behaviour)', async () => {
      NitroListDevFlags.stiLandingAdmission = false;
      const growth = await jumpWithSlices();
      expect(growth[0]).toBeGreaterThan(PREWARM_ADMISSION_BUDGET_ITEMS);
    });

    it('still converges exactly onto the target after slicing', async () => {
      await jumpWithSlices();
      const list = harness!;
      for (let round = 0; round < 15; round++) {
        list.measureAllCells(() => 20);
        await list.settle(50);
      }
      const expected = list.handle.getItemOffset(300) - (VIEWPORT_H - 20) / 2;
      expect(list.lastScrollTop()).toBeCloseTo(expected, 0);
    });
  });

  describe('O1.1/O1.2 — event-driven scrollToIndex wait', () => {
    it('converges with at most one confirmation pass when nothing is left to measure', async () => {
      harness = renderNitroList({
        data: makeItems(200),
        renderItem: () => null,
        estimatedItemSize: 100,
        keyExtractor: itemKey,
        getFixedItemSize: () => 100,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      NitroListPerfMonitor.enable();

      let promise!: Promise<void>;
      act(() => {
        promise = harness!.handle.scrollToIndex({index: 120});
      });
      await harness.settle(50);
      await promise;

      const stats = NitroListPerfMonitor.getSnapshot().lastScrollToIndex;
      expect(stats).not.toBeNull();
      expect(stats!.correctionPasses).toBeLessThanOrEqual(2);
      expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(120), 0);
      expect(harness.renderedIndices()).toContain(120);
    });

    async function measureAfterPrewarm(): Promise<number> {
      harness = renderNitroList({
        data: makeItems(200),
        renderItem: () => null,
        estimatedItemSize: 100,
        keyExtractor: itemKey,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      for (let round = 0; round < 3; round++) {
        harness.measureAllCells(() => 130);
        await harness.settle(50);
      }

      act(() => {
        void harness!.handle.scrollToIndex({index: 100});
      });
      await flushMicrotasks();
      expect(harness.renderedIndices()).toContain(100);
      const batchesBefore = countCalls(harness.mirror.callLog, 'setItemSizesBatch');
      harness.measureAllCells(() => 130);
      await flushMicrotasks();
      return countCalls(harness.mirror.callLog, 'setItemSizesBatch') - batchesBefore;
    }

    it('flushes freshly reported sizes as soon as the last cell lays out, without waiting for the rAF', async () => {
      expect(await measureAfterPrewarm()).toBe(1);
    });

    it('leaves the flush to the rAF with the event-driven wait disabled (baseline behaviour)', async () => {
      NitroListDevFlags.stiEventDrivenWait = false;
      expect(await measureAfterPrewarm()).toBe(0);
    });

    async function jumpWithWarmTypeMean(): Promise<{steps: number; batches: number; passes: number}> {
      const key = measurementCacheKey('dynamic', VIEWPORT_W, PixelRatio.getFontScale());
      for (let i = 0; i < 1500; i++) recordMeasurement(key, pseudoHeight(i));
      harness = renderNitroList(
        {
          data: makeItems(10000),
          renderItem: () => null,
          estimatedItemSize: 80,
          keyExtractor: itemKey,
          getItemType: () => 'dynamic',
          drawDistance: 500,
        },
        {asyncRangeDelivery: true},
      );
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      harness.measureUnmeasuredCells(pseudoHeight);
      await harness.settle(50);
      NitroListPerfMonitor.enable();
      NitroListPerfMonitor.reset();
      const batchesBefore = countCalls(harness.mirror.callLog, 'setItemSizesBatch');

      let done = false;
      act(() => {
        void harness!.handle
          .scrollToIndex({index: 8500, animated: false, viewPosition: 0.5})
          .then(() => (done = true), () => (done = true));
      });
      let steps = 0;
      while (!done && steps < 40) {
        act(() => {
          jest.runOnlyPendingTimers();
        });
        harness.measureUnmeasuredCells(pseudoHeight);
        await flushMicrotasks();
        steps++;
      }
      expect(done).toBe(true);
      const expected = harness.handle.getItemOffset(8500) - (VIEWPORT_H - pseudoHeight(8500)) / 2;
      expect(harness.lastScrollTop()).toBeCloseTo(expected, 0);
      const stats = NitroListPerfMonitor.getSnapshot().lastScrollToIndex;
      return {
        steps,
        batches: countCalls(harness.mirror.callLog, 'setItemSizesBatch') - batchesBefore,
        passes: stats?.correctionPasses ?? -1,
      };
    }

    it('does not chain edge-cell flushes inside the jump when the type mean is already warm', async () => {
      const result = await jumpWithWarmTypeMean();
      expect(result.steps).toBeLessThanOrEqual(3);
      expect(result.batches).toBeLessThanOrEqual(3);
      expect(result.passes).toBeLessThanOrEqual(1);
    });

    it('needs the fixed two-frame waits with the event-driven wait disabled (baseline behaviour)', async () => {
      NitroListDevFlags.stiEventDrivenWait = false;
      const result = await jumpWithWarmTypeMean();
      expect(result.steps).toBeGreaterThanOrEqual(5);
    });
  });

  describe('O3.2 — auto-fixed item types', () => {
    const rowType = () => 'row';

    async function warmUpType(list: NitroListHarness): Promise<void> {
      list.measureAllCells(() => 64);
      list.frame();
      list.scroll(1200);
      list.measureAllCells(() => 64);
      list.frame();
      list.scroll(2400);
      list.measureAllCells(() => 64);
      list.frame();
      await list.settle(20);
    }

    it('freezes a type after enough identical samples and stops enqueueing its cells', async () => {
      harness = renderNitroList<string>({
        data: makeItems(300),
        renderItem: () => null,
        estimatedItemSize: 60,
        keyExtractor: itemKey,
        getItemType: rowType,
        autoFixedItemSizes: true,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      await warmUpType(harness);

      const cells = harness.cellInstances();
      const anyIndex = Array.from(cells.keys())[0];
      expect(cells.get(anyIndex)!.props.autoFixedSize).toBe(64);
      expect(harness.handle.getItemSize(250)).toBe(64);
      expect(harness.handle.getAverageItemSizes().row.count).toBe(300);

      const batchesBefore = countCalls(harness.mirror.callLog, 'setItemSizesBatch');
      harness.measureCell(anyIndex, 64);
      harness.frame();
      expect(countCalls(harness.mirror.callLog, 'setItemSizesBatch')).toBe(batchesBefore);
    });

    it('unfreezes on a mismatching layout and reports the real size', async () => {
      harness = renderNitroList<string>({
        data: makeItems(300),
        renderItem: () => null,
        estimatedItemSize: 60,
        keyExtractor: itemKey,
        getItemType: rowType,
        autoFixedItemSizes: true,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      await warmUpType(harness);

      const index = Array.from(harness.cellInstances().keys())[0];
      harness.measureCell(index, 90);
      harness.frame();
      await harness.settle(20);

      expect(harness.handle.getItemSize(index)).toBe(90);
      const cells = harness.cellInstances();
      for (const cell of cells.values()) {
        expect(cell.props.autoFixedSize).toBeUndefined();
      }
    });

    it('seeds a fresh mount from the cross-mount cache and pushes every size up front', async () => {
      harness = renderNitroList<string>({
        data: makeItems(300),
        renderItem: () => null,
        estimatedItemSize: 60,
        keyExtractor: itemKey,
        getItemType: rowType,
        autoFixedItemSizes: true,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      await warmUpType(harness);
      harness.unmount();

      harness = renderNitroList<string>({
        data: makeItems(300),
        renderItem: () => null,
        estimatedItemSize: 60,
        keyExtractor: itemKey,
        getItemType: rowType,
        autoFixedItemSizes: true,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);

      expect(harness.handle.getItemSize(299)).toBe(64);
      expect(harness.handle.getTotalSize()).toBe(300 * 64);
      expect(harness.handle.getAverageItemSizes().row.count).toBe(300);
      const cells = harness.cellInstances();
      for (const cell of cells.values()) {
        expect(cell.props.autoFixedSize).toBe(64);
      }
    });

    it('stays off without the prop', async () => {
      harness = renderNitroList<string>({
        data: makeItems(300),
        renderItem: () => null,
        estimatedItemSize: 60,
        keyExtractor: itemKey,
        getItemType: rowType,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      await warmUpType(harness);
      for (const cell of harness.cellInstances().values()) {
        expect(cell.props.autoFixedSize).toBeUndefined();
      }
      expect(harness.handle.getAverageItemSizes().row.count).toBeLessThan(300);
    });
  });
});
