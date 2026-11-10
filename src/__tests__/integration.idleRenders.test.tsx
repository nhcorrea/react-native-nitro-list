import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {ReactTestInstance} from 'react-test-renderer';

import {areItemContainerPropsEqual, type NitroListItemContainerProps} from '../cells';
import {NitroListDevFlags} from '../devFlags';
import {clearMeasurementCache} from '../measurementCache';
import type {NitroListProps} from '../NitroList';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const SIZE = 64;

function styleOf(node: ReactTestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

function activeTops(harness: NitroListHarness): Map<number, number> {
  const wrappers = harness.renderer.root.findAll(
    (node) => (node.type as unknown) === 'View' && node.props.collapsable === false && styleOf(node).bottom === 0 && styleOf(node).left === 0,
  );
  expect(wrappers).toHaveLength(1);
  const base = styleOf(wrappers[0]).top as number;
  const tops = new Map<number, number>();
  const children = wrappers[0].props.children as ReadonlyArray<React.ReactElement<NitroListItemContainerProps>>;
  for (const child of children) {
    if (child.props.parked === true) continue;
    tops.set(child.props.index, base + child.props.top - child.props.origin);
  }
  return tops;
}

describe('idle renders', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListDevFlags.experimentalSlot03 = false;
    NitroListPerfMonitor.disable();
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mountMeasured(props: Partial<NitroListProps<string>>): Promise<NitroListHarness> {
    const mounted = renderNitroList({
      data: makeItems(400),
      renderItem: () => <View />,
      estimatedItemSize: SIZE,
      keyExtractor: itemKey,
      drawDistance: 500,
      ...props,
    });
    harness = mounted;
    mounted.layout(360, 628);
    await mounted.settle(50);
    for (let offset = 0; offset <= 3200; offset += 400) {
      mounted.scroll(offset);
      await mounted.settle(32);
      mounted.measureUnmeasuredCells(() => SIZE);
      await mounted.settle(32);
    }
    await mounted.settle(200);
    return mounted;
  }

  async function growLastCell(mounted: NitroListHarness) {
    const before = activeTops(mounted);
    const last = Math.max(...before.keys());
    const snapBefore = mounted.scrollProps.snapToOffsets?.[0];
    NitroListPerfMonitor.enable();
    mounted.measureCell(last, SIZE + 36);
    await mounted.settle(200);
    const cellsRenders = NitroListPerfMonitor.getSnapshot().cellsRenders;
    NitroListPerfMonitor.disable();
    return {before, after: activeTops(mounted), cellsRenders, snapBefore, snapAfter: mounted.scrollProps.snapToOffsets?.[0]};
  }

  for (const recycleItems of [false, true]) {
    it(`republishes the window when a layout revision moves no rendered cell, without the slot (recycleItems ${recycleItems})`, async () => {
      const mounted = await mountMeasured({recycleItems, snapToIndices: [300]});
      const {before, after, cellsRenders, snapBefore, snapAfter} = await growLastCell(mounted);
      expect(cellsRenders).toBeGreaterThanOrEqual(1);
      expect(after).toEqual(before);
      expect(snapAfter).toBeGreaterThan(snapBefore!);
    });

    it(`skips the window render and still runs the layout effects with the slot (recycleItems ${recycleItems})`, async () => {
      NitroListDevFlags.experimentalSlot03 = true;
      const mounted = await mountMeasured({recycleItems, snapToIndices: [300]});
      const {before, after, cellsRenders, snapBefore, snapAfter} = await growLastCell(mounted);
      expect(before.size).toBeGreaterThan(10);
      expect(cellsRenders).toBe(0);
      expect(after).toEqual(before);
      expect(snapAfter).toBeGreaterThan(snapBefore!);
    });

    it(`renders the window when a layout revision moves a rendered cell with the slot (recycleItems ${recycleItems})`, async () => {
      NitroListDevFlags.experimentalSlot03 = true;
      const mounted = await mountMeasured({recycleItems});
      const before = activeTops(mounted);
      const first = Math.min(...before.keys());
      mounted.measureCell(first, SIZE + 36);
      await mounted.settle(200);
      const after = activeTops(mounted);
      for (const [index, top] of before) {
        if (after.has(index)) expect(after.get(index)).toBe(top + (index > first ? 36 : 0));
      }
    });

    it(`lands every cell on the same screen position as the default path (recycleItems ${recycleItems})`, async () => {
      const play = async (slot: boolean) => {
        NitroListDevFlags.experimentalSlot03 = slot;
        clearMeasurementCache();
        const mounted = await mountMeasured({recycleItems});
        const sizeOf = (index: number) => SIZE + ((index * 7) % 5) * 9;
        for (const offset of [3600, 3000, 2400, 2900, 4200, 3700, 3764, 3828, 5200]) {
          mounted.scroll(offset);
          await mounted.settle(32);
          mounted.measureUnmeasuredCells(sizeOf);
          await mounted.settle(32);
        }
        await mounted.settle(200);
        const tops = activeTops(mounted);
        mounted.unmount();
        harness = null;
        return tops;
      };
      const expected = await play(false);
      const actual = await play(true);
      expect(actual).toEqual(expected);
    });
  }

  it('treats a parked-only change as equal props with the slot', () => {
    const props = {parked: undefined, top: 10, origin: 0, index: 3} as unknown as NitroListItemContainerProps;
    const parked = {...props, parked: true};
    expect(areItemContainerPropsEqual(props, parked)).toBe(false);
    NitroListDevFlags.experimentalSlot03 = true;
    expect(areItemContainerPropsEqual(props, parked)).toBe(true);
    expect(areItemContainerPropsEqual(props, {...parked, away: true})).toBe(false);
  });
});
