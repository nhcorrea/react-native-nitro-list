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
});
