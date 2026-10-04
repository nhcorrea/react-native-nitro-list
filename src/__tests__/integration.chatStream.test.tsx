import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import type {NitroListRenderItem} from '../NitroList';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {renderNitroList, type NitroListHarness} from './helpers/harness';

type Msg = {id: string; text: string; height: number};

const VIEWPORT_W = 400;
const VIEWPORT_H = 800;
const ITEM_SIZE = 80;
const COUNT = 500;
const UPDATES = 16;

describe('chat stream', () => {
  let harness: NitroListHarness<Msg> | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListPerfMonitor.disable();
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a growing tail message does not re-render the whole window', async () => {
    const renderItem: NitroListRenderItem<Msg> = ({item}) => (
      <View style={{height: item.height}} />
    );
    let msgs: Msg[] = Array.from({length: COUNT}, (_, i) => ({
      id: `m${i}`,
      text: `msg ${i}`,
      height: ITEM_SIZE,
    }));
    harness = renderNitroList<Msg>({
      data: msgs,
      renderItem,
      estimatedItemSize: ITEM_SIZE,
      keyExtractor: (item) => item.id,
      getItemType: () => 'msg',
      drawDistance: 500,
      maintainScrollAtEnd: true,
      anchoredEndSpace: {anchorIndex: COUNT - 1},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => ITEM_SIZE);
    await harness.settle(50);
    harness.scroll(COUNT * ITEM_SIZE - VIEWPORT_H);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => ITEM_SIZE);
    await harness.settle(50);

    const mountedBefore = harness.cellInstances().size;
    expect(mountedBefore).toBeGreaterThan(10);

    NitroListPerfMonitor.enable();
    for (let t = 1; t <= UPDATES; t++) {
      const grow = t % 8 === 0 ? 20 : 0;
      const next = msgs.slice();
      const lastIndex = next.length - 1;
      const last = next[lastIndex];
      next[lastIndex] = {...last, text: `${last.text} tok${t}`, height: last.height + grow};
      msgs = next;
      harness.update({data: msgs});
      await harness.settle(20);
      if (grow > 0) harness.measureCell(lastIndex, next[lastIndex].height);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
      await harness.settle(20);
    }
    const snapshot = NitroListPerfMonitor.getSnapshot();
    console.info(
      'CHAT_STREAM',
      JSON.stringify({
        itemRenders: snapshot.itemRenders,
        updates: UPDATES,
        mounted: mountedBefore,
      }),
    );
    expect(snapshot.itemRenders).toBeLessThanOrEqual(UPDATES + 2);
  }, 60000);

  async function followGrowingTail(recycleItems: boolean, updateBeforeFlush = false) {
    const heightFor = (index: number) => 40 + (((index * 2654435761) >>> 0) % 161);
    const renderItem: NitroListRenderItem<Msg> = ({item}) => (
      <View style={{height: item.height}} />
    );
    const lastIndex = COUNT - 1;
    let msgs: Msg[] = Array.from({length: COUNT}, (_, i) => ({
      id: `m${i}`,
      text: `msg ${i}`,
      height: i === lastIndex ? 40 : heightFor(i),
    }));
    harness = renderNitroList<Msg>({
      data: msgs,
      renderItem,
      estimatedItemSize: 104,
      keyExtractor: (item) => item.id,
      drawDistance: 500,
      maintainScrollAtEnd: true,
      recycleItems,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureUnmeasuredCells((i) => msgs[i].height);
    await harness.settle(50);
    void harness.handle.scrollToEnd(false);
    for (let pass = 0; pass < 6; pass++) {
      await harness.settle(100);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
    }
    await harness.settle(500);

    const restBefore = harness.mirror.getTotalSize() - msgs[lastIndex].height;
    const restSizes: number[] = [];
    NitroListPerfMonitor.enable();
    for (let t = 1; t <= 120; t++) {
      const next = msgs.slice();
      const grow = t % 2 === 0 ? 19 : 0;
      next[lastIndex] = {...next[lastIndex], text: `${next[lastIndex].text} tok${t}`, height: next[lastIndex].height + grow};
      msgs = next;
      harness.update({data: msgs});
      await harness.settle(25);
      if (grow > 0) harness.measureCell(lastIndex, msgs[lastIndex].height);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
      if (!updateBeforeFlush) await harness.settle(25);
      restSizes.push(harness.mirror.getTotalSize() - harness.mirror.getItemSize(lastIndex));
    }
    await harness.settle(500);
    const snapshot = NitroListPerfMonitor.getSnapshot();
    const endGap = harness.mirror.getTotalSize() - VIEWPORT_H - harness.observedNativeOffset;
    const restChanges = restSizes.filter((rest, i) => rest !== (i === 0 ? restBefore : restSizes[i - 1])).length;
    console.info(
      'CHAT_TAIL',
      JSON.stringify({
        recycleItems,
        updateBeforeFlush,
        scrollToIndexStarts: snapshot.scrollToIndexStarts,
        itemMounts: snapshot.itemMounts,
        itemUnmounts: snapshot.itemUnmounts,
        endGap,
        restChanges,
        tail: msgs[lastIndex].height,
      }),
    );
    expect(snapshot.scrollToIndexStarts).toBe(0);
    expect(snapshot.itemMounts).toBeLessThanOrEqual(2);
    expect(Math.abs(endGap)).toBeLessThanOrEqual(1);
    expect(restChanges).toBe(0);
  }

  it('follows a tail message that outgrows the viewport without index jumps or remounts', async () => {
    await followGrowingTail(false);
  }, 60000);

  it('follows a growing tail with recycled cells and keeps the estimates of the other items', async () => {
    await followGrowingTail(true);
  }, 60000);

  it('keeps the estimates of the other items when the tail size is still queued at the next update', async () => {
    await followGrowingTail(true, true);
  }, 60000);

  it('follows a growing tail in the commit that renders it when the host measures synchronously', async () => {
    const methodsModule = require('@react-native/jest-preset/jest/MockNativeMethods') as {
      default?: {measureLayout: jest.Mock};
      measureLayout: jest.Mock;
    };
    const methods = methodsModule.default ?? methodsModule;
    const renderItem: NitroListRenderItem<Msg> = ({item}) => <View style={{height: item.height}} />;
    let msgs: Msg[] = Array.from({length: COUNT}, (_, i) => ({id: `m${i}`, text: `msg ${i}`, height: ITEM_SIZE}));
    methods.measureLayout.mockImplementation(function (
      this: {props?: {children?: {props?: {index?: number}}}},
      _relative: unknown,
      onSuccess: unknown,
    ) {
      const index = this?.props?.children?.props?.index;
      if (typeof index !== 'number' || typeof onSuccess !== 'function') return;
      (onSuccess as (x: number, y: number, width: number, height: number) => void)(0, 0, VIEWPORT_W, msgs[index].height);
    } as never);
    try {
      harness = renderNitroList<Msg>({
        data: msgs,
        renderItem,
        estimatedItemSize: ITEM_SIZE,
        keyExtractor: (item) => item.id,
        drawDistance: 500,
        maintainScrollAtEnd: true,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      harness.measureAllCells(() => ITEM_SIZE);
      await harness.settle(50);
      void harness.handle.scrollToEnd(false);
      await harness.settle(200);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
      await harness.settle(200);
      const lastIndex = COUNT - 1;
      for (let g = 1; g <= 6; g++) {
        const next = msgs.slice();
        next[lastIndex] = {...next[lastIndex], text: `${next[lastIndex].text} line`, height: next[lastIndex].height + 38};
        msgs = next;
        harness.update({data: msgs});
        const end = harness.mirror.getTotalSize() - VIEWPORT_H;
        expect(harness.mirror.getItemSize(lastIndex)).toBe(msgs[lastIndex].height);
        expect(harness.scrollCommands[harness.scrollCommands.length - 1]?.y).toBeCloseTo(end, 3);
        await harness.settle(50);
      }
    } finally {
      methods.measureLayout.mockReset();
    }
  }, 60000);

  it('keeps the offsets of items before the growing one exact', async () => {
    const renderItem: NitroListRenderItem<Msg> = ({item}) => (
      <View style={{height: item.height}} />
    );
    let msgs: Msg[] = Array.from({length: COUNT}, (_, i) => ({
      id: `m${i}`,
      text: `msg ${i}`,
      height: ITEM_SIZE,
    }));
    harness = renderNitroList<Msg>({
      data: msgs,
      renderItem,
      estimatedItemSize: ITEM_SIZE,
      keyExtractor: (item) => item.id,
      getItemType: () => 'msg',
      drawDistance: 500,
      maintainScrollAtEnd: true,
      anchoredEndSpace: {anchorIndex: COUNT - 1},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => ITEM_SIZE);
    await harness.settle(50);
    harness.scroll(COUNT * ITEM_SIZE - VIEWPORT_H);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => ITEM_SIZE);
    await harness.settle(50);

    const lastIndex = COUNT - 1;
    for (let g = 1; g <= 2; g++) {
      const next = msgs.slice();
      next[lastIndex] = {...next[lastIndex], height: next[lastIndex].height + 20};
      msgs = next;
      harness.update({data: msgs});
      await harness.settle(20);
      harness.measureCell(lastIndex, next[lastIndex].height);
      harness.measureUnmeasuredCells((i) => msgs[i].height);
      await harness.settle(20);
      expect(harness.mirror.getItemOffset(400)).toBe(400 * ITEM_SIZE);
      expect(harness.mirror.getTotalSize()).toBe(COUNT * ITEM_SIZE + g * 20);
    }
  }, 60000);
});
