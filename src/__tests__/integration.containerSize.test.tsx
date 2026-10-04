import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {StyleSheet, View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT = 800;
const heightFor = (index: number) => 60 + (((index * 2654435761) >>> 0) % 140);

describe('content container size', () => {
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

  function containerHeight(): number {
    const containers = harness!.renderer.root.findAll(
      (node) =>
        node.type === View &&
        node.props.collapsable === false &&
        typeof (StyleSheet.flatten(node.props.style) as {height?: unknown} | undefined)?.height === 'number',
    );
    return Math.max(...containers.map((node) => (StyleSheet.flatten(node.props.style) as {height: number}).height));
  }

  it('keeps the native content height while measurements move the total far from the end', async () => {
    harness = renderNitroList({data: makeItems(2000), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, VIEWPORT);
    harness.measureUnmeasuredCells(heightFor);
    await harness.settle(50);
    for (let step = 1; step <= 10; step++) {
      harness.scroll(step * 300);
      await harness.settle(16);
      harness.measureUnmeasuredCells(heightFor);
      await harness.settle(16);
    }
    const heights = new Set<number>();
    const totals = new Set<number>();
    let uncovered = 0;
    for (let step = 11; step <= 60; step++) {
      harness.scroll(step * 300);
      await harness.settle(16);
      harness.measureUnmeasuredCells(heightFor);
      await harness.settle(16);
      const height = containerHeight();
      const total = harness.mirror.getTotalSize();
      heights.add(height);
      totals.add(total);
      if (height < total - 1) uncovered++;
    }
    expect(totals.size).toBeGreaterThan(10);
    expect(heights.size).toBeLessThanOrEqual(2);
    expect(uncovered).toBe(0);
  });

  it('matches the exact total near the end', async () => {
    harness = renderNitroList({data: makeItems(200), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, VIEWPORT);
    harness.measureUnmeasuredCells(heightFor);
    await harness.settle(50);
    void harness.handle.scrollToEnd(false);
    for (let pass = 0; pass < 6; pass++) {
      await harness.settle(100);
      harness.measureUnmeasuredCells(heightFor);
    }
    await harness.settle(200);
    expect(containerHeight()).toBe(harness.mirror.getTotalSize());
  });
});
