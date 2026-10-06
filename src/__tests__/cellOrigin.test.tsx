import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {StyleSheet} from 'react-native';
import type {ReactTestInstance} from 'react-test-renderer';

import {CELL_ORIGIN_SEGMENT, nextCellOrigin} from '../cells';
import {clearWarnDevOnceForTests} from '../devWarnings';
import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const DEPTH = 12_500_000;
const FLOAT_EXACT_SPAN = 2 ** 17;

function styleOf(node: ReactTestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
}

describe('cell origin', () => {
  let harness: NitroListHarness | null = null;
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    clearMeasurementCache();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  it('keeps the origin while the window stays less than two segments below it', () => {
    expect(nextCellOrigin(0, 1000)).toBe(0);
    expect(nextCellOrigin(0, DEPTH)).toBe(Math.floor(DEPTH / CELL_ORIGIN_SEGMENT) * CELL_ORIGIN_SEGMENT);
    const origin = 190 * CELL_ORIGIN_SEGMENT;
    expect(nextCellOrigin(origin, origin + 1.5 * CELL_ORIGIN_SEGMENT)).toBe(origin);
    expect(nextCellOrigin(origin, origin + 2 * CELL_ORIGIN_SEGMENT)).toBe(origin + 2 * CELL_ORIGIN_SEGMENT);
    expect(nextCellOrigin(origin, origin - 1)).toBe(origin - CELL_ORIGIN_SEGMENT);
  });

  it.each([false, true])('positions deep cells by small offsets from a float-exact origin (recycleItems %s)', async (recycleItems) => {
    harness = renderNitroList({data: makeItems(100_000), renderItem: () => null, estimatedItemSize: 200, keyExtractor: itemKey, recycleItems});
    harness.layout(400, 800);
    harness.measureUnmeasuredCells(() => 200);
    await harness.settle(50);
    for (const offset of [DEPTH, DEPTH + 3000]) {
      harness.scroll(offset);
      await harness.settle(16);
      harness.measureUnmeasuredCells(() => 200);
    }
    await harness.settle(50);
    expect(harness.renderedIndices()).toContain((DEPTH + 3000) / 200);

    const containers = harness.renderer.root.findAll(
      (node) => typeof node.type !== 'string' && typeof node.props.top === 'number' && typeof node.props.origin === 'number',
    );
    expect(containers.length).toBeGreaterThan(0);
    const origin = containers[0].props.origin as number;
    expect(origin).toBeGreaterThan(0);
    expect(origin % CELL_ORIGIN_SEGMENT).toBe(0);
    for (const container of containers) {
      expect(container.props.origin).toBe(origin);
      if (container.props.parked === true) continue;
      const host = container.find((node) => (node.type as unknown) === 'View');
      const top = styleOf(host).top as number;
      expect(top).toBe(container.props.top - origin);
      expect(Math.abs(top)).toBeLessThan(FLOAT_EXACT_SPAN);
    }
    const wrappers = harness.renderer.root.findAll(
      (node) => (node.type as unknown) === 'View' && node.props.collapsable === false && styleOf(node).top === origin && styleOf(node).bottom === 0,
    );
    expect(wrappers).toHaveLength(1);
  });
});
