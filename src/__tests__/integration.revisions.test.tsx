import {afterEach, beforeEach, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Dimensions, View} from 'react-native';
import {act} from 'react-test-renderer';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

let harness: NitroListHarness;
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  harness?.unmount();
  jest.useRealTimers();
});

it('a delayed measurement after reorder cannot resize the new occupant of its old index', async () => {
  harness = renderNitroList({
    data: makeItems(3),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
  });
  harness.layout(400, 600);
  harness.measureAllCells(() => 100);
  await harness.settle(50);
  const oldLayout = harness
    .cellInstances()
    .get(0)!
    .findAll((node) => node.type === View && node.props.onLayout != null)[0].props.onLayout;
  harness.update({data: ['item-1', 'item-2', 'item-0']});
  act(() => {
    oldLayout({nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 200}}});
  });
  await harness.settle(50);
  expect(harness.handle.getItemSize(0)).toBe(100);
});

it('an abandoned horizontal render cannot change the handle of the committed vertical tree', async () => {
  harness = renderNitroList({
    data: makeItems(3),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
  });
  harness.layout(400, 600);
  harness.measureAllCells(() => 100);
  await harness.settle(50);
  const before = harness.handle.getLayout(1);
  expect(before).toEqual({x: 0, y: 100, width: 400, height: 100});
  const never = new Promise<void>(() => {});
  let attempted = false;
  await act(async () => {
    React.startTransition(() =>
      harness.update({
        horizontal: true,
        renderItem: () => {
          attempted = true;
          throw never;
        },
      }),
    );
  });
  expect(attempted).toBe(true);
  expect(harness.cellInstances().get(1)!.props.horizontal).toBe(false);
  expect(harness.handle.getLayout(1)).toEqual(before);
});

it('shrinking after removing the head preserves measurements from the old tail', async () => {
  harness = renderNitroList({
    data: makeItems(3),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
  });
  harness.layout(400, 600);
  harness.measureAllCells((index) => (index + 1) * 100);
  await harness.settle(50);
  harness.update({data: ['item-1', 'item-2']});
  expect(harness.handle.getItemSize(0)).toBe(200);
  expect(harness.handle.getItemSize(1)).toBe(300);
});

it('a queued size from replaced content never overrides the frame reported by the new content', async () => {
  const onItemSizeChanged = jest.fn();
  harness = renderNitroList({
    data: ['old'],
    keyExtractor: () => 'same',
    estimatedItemSize: 100,
    renderItem: () => null,
    onItemSizeChanged,
  });
  harness.layout(400, 600);
  harness.measureAllCells(() => 250);
  harness.update({data: ['new']});
  expect(harness.handle.getItemSize(0)).toBe(250);
  harness.measureCell(0, 180);
  await harness.settle(50);
  expect(harness.handle.getItemSize(0)).toBe(180);
  expect(onItemSizeChanged.mock.calls).toEqual([[{index: 0, size: 180}]]);
});

it('a width change drops offscreen geometry and re-supplies mounted cells with their latest frame', async () => {
  harness = renderNitroList(
    {
      data: makeItems(40),
      keyExtractor: itemKey,
      estimatedItemSize: 100,
      renderItem: () => null,
    },
    {typeAverages: false},
  );
  harness.layout(400, 600);
  harness.measureAllCells(() => 200);
  await harness.settle(50);
  harness.scroll(3000);
  await harness.settle(20);
  harness.measureUnmeasuredCells(() => 200);
  await harness.settle(20);
  const offscreen = harness.renderedIndices()[0];
  harness.scroll(0);
  await harness.settle(50);
  harness.measureUnmeasuredCells(() => 200);
  await harness.settle(50);
  expect(harness.renderedIndices()).not.toContain(offscreen);
  expect(harness.handle.getItemSize(offscreen)).toBe(200);
  expect(harness.handle.getItemSize(0)).toBe(200);
  const layoutOfFirst = harness
    .cellInstances()
    .get(0)!
    .findAll((node) => node.type === View && node.props.onLayout != null)[0].props.onLayout;
  harness.layout(300, 600);
  await harness.settle(50);
  expect(harness.handle.getItemSize(offscreen)).toBe(100);
  expect(harness.handle.getItemSize(0)).toBe(200);
  act(() => layoutOfFirst({nativeEvent: {layout: {x: 0, y: 0, width: 300, height: 250}}}));
  await harness.settle(50);
  expect(harness.handle.getItemSize(0)).toBe(250);
});

it('coalesces repeated sizes into one batch without the old callback/refill path', async () => {
  const onItemSizeChanged = jest.fn();
  harness = renderNitroList({
    data: makeItems(3),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
    onItemSizeChanged,
  });
  harness.layout(400, 600);
  await harness.settle(50);
  harness.mirror.callLog.length = 0;
  harness.measureCell(0, 120);
  harness.measureCell(0, 150);
  await harness.settle(20);
  expect(harness.handle.getItemSize(0)).toBe(150);
  expect(onItemSizeChanged.mock.calls).toEqual([[{index: 0, size: 150}]]);
  expect(harness.mirror.callLog.filter((call) => call === 'setItemSizesAndFill')).toHaveLength(1);
  expect(harness.mirror.callLog).not.toContain('setItemSizesBatch');
  expect(harness.mirror.callLog).not.toContain('fillLayoutSlab');
});

it('recreates fixed geometry when StrictMode replays the engine effects', async () => {
  harness = renderNitroList(
    {
      data: makeItems(3),
      keyExtractor: itemKey,
      estimatedItemSize: 100,
      getItemType: () => 'fixed',
      getFixedItemSize: () => 175,
      renderItem: () => null,
    },
    undefined,
    true,
  );
  harness.layout(400, 600);
  await harness.settle(50);
  expect(harness.handle.getItemSize(2)).toBe(175);
  expect(harness.handle.getTotalSize()).toBe(525);
});

it('does not continue old size notifications after a callback synchronously replaces the data', async () => {
  const reports: number[] = [];
  harness = renderNitroList({
    data: makeItems(3),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
    onItemSizeChanged: (info) => {
      reports.push(info.index);
      if (reports.length === 1) {
        const renderer = harness.renderer as typeof harness.renderer & {
          unstable_flushSync: (fn: () => void) => void;
        };
        renderer.unstable_flushSync(() => harness.update({data: makeItems(3, 10), dataVersion: 1}));
      }
    },
  });
  harness.layout(400, 600);
  harness.measureAllCells(() => 150);
  await harness.settle(20);
  expect(reports).toEqual([0]);
  expect(harness.handle.getItemSize(1)).toBe(100);
});

it('invalidates offscreen measurements when font scale changes without an outer layout event', async () => {
  const window = Dimensions.get('window');
  harness = renderNitroList({
    data: makeItems(40),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
  });
  harness.layout(400, 600);
  harness.measureAllCells(() => 175);
  await harness.settle(30);
  harness.scroll(2000);
  await harness.settle(20);
  expect(harness.handle.getItemSize(0)).toBe(175);
  try {
    act(() => Dimensions.set({window: {...window, fontScale: window.fontScale + 0.25}}));
    expect(harness.handle.getItemSize(0)).toBe(100);
  } finally {
    act(() => Dimensions.set({window}));
  }
});

it('evaluates edge callbacks from a UI engine event without a JS scroll event', async () => {
  const onEndReached = jest.fn();
  harness = renderNitroList({
    data: makeItems(20),
    keyExtractor: itemKey,
    estimatedItemSize: 100,
    renderItem: () => null,
    experimentalUiThreadScroll: true,
    onEndReached,
  });
  harness.layout(400, 600);
  await harness.settle(30);
  expect(onEndReached).not.toHaveBeenCalled();
  act(() => harness.mirror.setScrollOffset(1400));
  await harness.settle(20);
  expect(harness.lastScrollTop()).toBe(1400);
  expect(onEndReached).toHaveBeenCalledTimes(1);
});
