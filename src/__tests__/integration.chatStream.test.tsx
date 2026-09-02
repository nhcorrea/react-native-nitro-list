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
