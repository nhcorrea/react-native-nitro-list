import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_H = 800;

describe('animated scrollToIndex approach', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    jest.useRealTimers();
  });

  async function jumpTo(index: number) {
    harness = renderNitroList({data: makeItems(2000), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, VIEWPORT_H);
    harness.measureUnmeasuredCells(() => 100);
    await harness.settle(50);
    const before = harness.scrollCommands.length;
    act(() => {
      harness!.handle.scrollToIndex({index, animated: true});
    });
    for (let k = 0; k < 40; k++) {
      await harness.settle(16);
      harness.measureUnmeasuredCells(() => 100);
    }
    await harness.settle(500);
    return harness.scrollCommands.slice(before);
  }

  it('jumps without animation to two viewports before a far target, then animates the rest', async () => {
    const commands = await jumpTo(1200);
    const animatedAt = commands.findIndex((command) => command.animated);
    expect(animatedAt).toBeGreaterThan(0);
    const approach = commands[animatedAt - 1];
    expect(approach.animated).toBe(false);
    expect(commands[animatedAt].y - approach.y).toBeCloseTo(2 * VIEWPORT_H, 0);
    expect(harness!.renderedIndices()).toContain(1200);
  });

  it('animates a near target directly', async () => {
    const commands = await jumpTo(12);
    expect(commands[0].animated).toBe(true);
  });

  it('lands a deep animated jump on its target when the animation also reports momentum', async () => {
    const target = 60000;
    const heightOf = (index: number) => 180 + (index % 4) * 30;
    harness = renderNitroList({
      data: makeItems(100000),
      renderItem: () => null,
      estimatedItemSize: 120,
      keyExtractor: itemKey,
      getItemType: (_item: string, index: number) => index % 2,
    });
    harness.layout(400, VIEWPORT_H);
    harness.measureUnmeasuredCells(heightOf);
    await harness.settle(50);
    harness.animatedScrollFrames = 30;
    harness.animatedMomentumBegin = true;
    act(() => {
      harness!.handle.scrollToIndex({index: target, animated: true});
    });
    for (let k = 0; k < 80; k++) {
      await harness.settle(16);
      harness.measureUnmeasuredCells(heightOf);
    }
    await harness.settle(8000);
    harness.measureUnmeasuredCells(heightOf);
    await harness.settle(100);
    expect(Math.abs(harness.handle.getItemOffset(target) - harness.lastScrollTop())).toBeLessThanOrEqual(1);
  });

  it('lands a deep animated jump on the exact destination when float echoes hide a sub-dp drift', async () => {
    const target = 60000;
    harness = renderNitroList({data: makeItems(100000), renderItem: () => null, estimatedItemSize: 250, keyExtractor: itemKey});
    harness.layout(400, VIEWPORT_H);
    harness.measureUnmeasuredCells(() => 250.25);
    await harness.settle(50);
    harness.animatedScrollFrames = 8;
    harness.echoQuantizer = Math.fround;
    const before = harness.scrollCommands.length;
    act(() => {
      harness!.handle.scrollToIndex({index: target, animated: true});
    });
    let drifted = false;
    for (let k = 0; k < 60; k++) {
      await harness.settle(16);
      harness.measureUnmeasuredCells(() => 250.25);
      if (!drifted && harness.scrollCommands.slice(before).some((command) => command.animated)) {
        harness.measureCell(target - 1, 251);
        drifted = true;
      }
    }
    await harness.settle(1000);
    const destination = harness.handle.getItemOffset(target);
    expect(destination).toBeGreaterThan(2 ** 23);
    expect(drifted).toBe(true);
    const commands = harness.scrollCommands.slice(before);
    expect(commands[commands.length - 1].y).toBe(destination);
  });
});
