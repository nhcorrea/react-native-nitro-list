import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {useEffect} from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import {MVCP_ANCHOR_BASE} from '../mvcp';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 800;
const heightFor = (index: number) => 40 + (index % 5) * 20;
const heightForKey = (item: string) => 100 + (Number(item.slice('item-'.length)) % 5) * 10;

describe('recycleItems', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function scrollOutAndBack(recycleItems: boolean) {
    let mounts = 0;
    const Row = () => {
      useEffect(() => {
        mounts++;
      }, []);
      return <View />;
    };
    const renderItem: NitroListRenderItem<string> = ({target}) => (target === 'Cell' ? <Row /> : null);
    harness = renderNitroList({
      data: makeItems(1000),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      drawDistance: 500,
      recycleItems,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureUnmeasuredCells(heightFor);
    await harness.settle(50);
    const steps = [...Array.from({length: 60}, (_, step) => (step + 1) * 100), ...Array.from({length: 60}, (_, step) => (59 - step) * 100)];
    for (const offset of steps) {
      harness.scroll(offset);
      await harness.settle(16);
      harness.measureUnmeasuredCells(heightFor);
    }
    await harness.settle(100);
    const rendered = harness.renderedIndices();
    const sizes = rendered.map((index) => harness!.mirror.getItemSize(index));
    const result = {mounts, rendered, sizes};
    harness.unmount();
    harness = null;
    clearMeasurementCache();
    return result;
  }

  it('reuses cells across items instead of mounting one per traversed item', async () => {
    const recycled = await scrollOutAndBack(true);
    const mounted = await scrollOutAndBack(false);
    expect(recycled.mounts).toBeLessThan(mounted.mounts / 3);
    expect(recycled.rendered).toEqual(mounted.rendered);
  });

  it('a reused cell reports the size of its new item, never the previous occupant', async () => {
    const recycled = await scrollOutAndBack(true);
    expect(recycled.sizes).toEqual(recycled.rendered.map(heightFor));
  });

  it('keeps the anchored item still and its size when items are prepended', async () => {
    const items = makeItems(100);
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: true,
      recycleItems: true,
    });
    const measureRendered = (list: string[]) => {
      for (const index of harness!.renderedIndices()) harness!.measureCell(index, heightForKey(list[index]));
    };
    const anchorTop = () =>
      harness!.renderer.root.findAll(
        (node) => typeof node.props?.top === 'number' && node.props.top >= MVCP_ANCHOR_BASE / 2,
      )[0].props.top as number;
    harness.layout(VIEWPORT_W, 600);
    measureRendered(items);
    await harness.settle(50);
    harness.scroll(500);
    measureRendered(items);
    await harness.settle(50);
    const anchorBefore = anchorTop();
    const scrollBefore = harness.lastScrollTop();
    const sizeOfOldFirst = harness.handle.getItemSize(0);

    const prepended = [...makeItems(10, 1000), ...items];
    harness.update({data: prepended});
    await harness.settle(50);

    expect(harness.handle.getItemSize(10)).toBe(sizeOfOldFirst);
    const extent = harness.handle.getItemOffset(10);
    expect(harness.lastScrollTop()).toBeCloseTo(scrollBefore + extent, 3);
    expect(anchorTop()).toBeCloseTo(anchorBefore + extent, 3);
  });
});
