import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {ReactTestInstance} from 'react-test-renderer';

import {WINDOW_SHIFT_FOLD_LIMIT} from '../cells';
import {NitroListDevFlags} from '../devFlags';
import {clearMeasurementCache} from '../measurementCache';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const SIZE = 64;
const GROWTH = 36;

function styleOf(node: ReactTestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

function originTop(harness: NitroListHarness): number {
  const wrappers = harness.renderer.root.findAll(
    (node) => (node.type as unknown) === 'View' && node.props.collapsable === false && styleOf(node).bottom === 0 && styleOf(node).left === 0,
  );
  expect(wrappers).toHaveLength(1);
  return styleOf(wrappers[0]).top as number;
}

function screenTops(harness: NitroListHarness): Map<number, number> {
  const base = originTop(harness);
  const tops = new Map<number, number>();
  for (const [index, cell] of harness.cellInstances()) {
    const host = cell.find((node) => (node.type as unknown) === 'View');
    tops.set(index, base + (styleOf(host).top as number));
  }
  return tops;
}

describe('window shift', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListDevFlags.experimentalSlot01 = false;
    NitroListPerfMonitor.disable();
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mountMeasured(recycleItems: boolean): Promise<NitroListHarness> {
    const mounted = renderNitroList({
      data: makeItems(400),
      renderItem: () => <View />,
      estimatedItemSize: SIZE,
      keyExtractor: itemKey,
      drawDistance: 500,
      recycleItems,
    });
    harness = mounted;
    mounted.layout(360, 628);
    await mounted.settle(50);
    mounted.measureUnmeasuredCells(() => SIZE);
    await mounted.settle(50);
    mounted.scroll(6400);
    await mounted.settle(100);
    mounted.measureUnmeasuredCells(() => SIZE);
    await mounted.settle(100);
    return mounted;
  }

  async function growFirstCell(mounted: NitroListHarness, size: number) {
    const first = mounted.renderedIndices()[0];
    const before = screenTops(mounted);
    NitroListPerfMonitor.enable();
    mounted.measureCell(first, size);
    await mounted.settle(100);
    const renders = NitroListPerfMonitor.getSnapshot().itemRenders;
    NitroListPerfMonitor.disable();
    return {first, before, renders, after: screenTops(mounted)};
  }

  for (const recycleItems of [false, true]) {
    it(`re-renders the cells below a resized item without the slot (recycleItems ${recycleItems})`, async () => {
      const mounted = await mountMeasured(recycleItems);
      const {first, before, renders, after} = await growFirstCell(mounted, SIZE + GROWTH);
      expect(renders).toBeGreaterThanOrEqual(before.size - 2);
      const drift = after.get(first)! - before.get(first)!;
      for (const [index, top] of after) {
        if (!before.has(index)) continue;
        expect(top).toBeCloseTo(before.get(index)! + drift + (index > first ? GROWTH : 0), 3);
      }
    });

    it(`keeps the cells below a resized item untouched with the slot (recycleItems ${recycleItems})`, async () => {
      NitroListDevFlags.experimentalSlot01 = true;
      const mounted = await mountMeasured(recycleItems);
      const {first, before, renders, after} = await growFirstCell(mounted, SIZE + GROWTH);
      expect(before.size).toBeGreaterThan(10);
      expect(renders).toBeLessThanOrEqual(2);
      const drift = after.get(first)! - before.get(first)!;
      for (const [index, top] of after) {
        if (!before.has(index)) continue;
        expect(top).toBeCloseTo(before.get(index)! + drift + (index > first ? GROWTH : 0), 3);
      }
    });

    it(`folds an oversized shift back into the origin (recycleItems ${recycleItems})`, async () => {
      NitroListDevFlags.experimentalSlot01 = true;
      const mounted = await mountMeasured(recycleItems);
      const origin = originTop(mounted);
      const {first, before, after} = await growFirstCell(mounted, SIZE + WINDOW_SHIFT_FOLD_LIMIT + 8);
      expect(originTop(mounted)).toBe(origin);
      const drift = after.get(first)! - before.get(first)!;
      for (const [index, top] of after) {
        if (!before.has(index)) continue;
        expect(top).toBeCloseTo(before.get(index)! + drift + (index > first ? WINDOW_SHIFT_FOLD_LIMIT + 8 : 0), 3);
      }
    });

    it(`lands every cell on the same screen position as the default path (recycleItems ${recycleItems})`, async () => {
      const play = async (slot: boolean) => {
        NitroListDevFlags.experimentalSlot01 = slot;
        clearMeasurementCache();
        const mounted = await mountMeasured(recycleItems);
        const sizeOf = (index: number) => SIZE + ((index * 7) % 5) * 9;
        for (const offset of [6400, 5800, 5200, 4600, 5400, 7000, 6100]) {
          mounted.scroll(offset);
          await mounted.settle(32);
          mounted.measureUnmeasuredCells(sizeOf);
          await mounted.settle(32);
        }
        await mounted.settle(200);
        const tops = screenTops(mounted);
        mounted.unmount();
        harness = null;
        return tops;
      };
      const expected = await play(false);
      const actual = await play(true);
      expect([...actual.keys()].sort((a, b) => a - b)).toEqual([...expected.keys()].sort((a, b) => a - b));
      for (const [index, top] of expected) expect(actual.get(index)).toBeCloseTo(top, 3);
    });
  }
});
