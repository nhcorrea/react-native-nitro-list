import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {Platform} from 'react-native';
import type {ReactTestInstance} from 'react-test-renderer';

import {FLOW_REST_MS} from '../cells';
import {NitroListDevFlags} from '../devFlags';
import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 800;
const ROW = 100;
const STEPS = 5;

function root(harness: NitroListHarness): ReactTestInstance {
  return harness.renderer.root.find(
    (node) =>
      (node.type as unknown) === 'View' &&
      (node.props.nativeID === 'nitrolist-flow-root' || node.props.nativeID === 'nitrolist-absolute-root'),
  );
}

function cells(harness: NitroListHarness): ReactTestInstance[] {
  return root(harness).findAll(
    (node) =>
      typeof node.type === 'function' &&
      node.props != null &&
      typeof node.props.index === 'number' &&
      typeof node.props.origin === 'number' &&
      node.props.enqueueItemSize != null,
  );
}

function activeIndices(nodes: ReactTestInstance[]): number[] {
  return nodes.filter((node) => node.props.parked !== true).map((node) => node.props.index as number);
}

function ascending(values: number[]): boolean {
  return values.every((value, position) => position === 0 || value > values[position - 1]);
}

function sameRelativeOrder(before: ReactTestInstance[], after: ReactTestInstance[]): boolean {
  const kept = before.filter((node) => after.includes(node));
  const still = after.filter((node) => before.includes(node));
  return kept.length > 0 && kept.every((node, position) => still[position] === node);
}

describe('contiguous flow at rest', () => {
  const originalPlatform = Platform.OS;
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
    Platform.OS = 'android';
    NitroListDevFlags.experimentalContiguousFlow = true;
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListDevFlags.experimentalContiguousFlow = false;
    NitroListDevFlags.experimentalSlot01 = false;
    Platform.OS = originalPlatform;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mountAtRest(): Promise<ReactTestInstance[]> {
    harness = renderNitroList({
      data: makeItems(1000),
      renderItem: () => null,
      estimatedItemSize: ROW,
      keyExtractor: itemKey,
      drawDistance: 300,
      recycleItems: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureUnmeasuredCells(() => ROW);
    await harness.settle(2000);
    harness.measureUnmeasuredCells(() => ROW);
    await harness.settle(50);
    expect(root(harness).props.nativeID).toBe('nitrolist-flow-root');
    const mounted = cells(harness);
    expect(ascending(activeIndices(mounted))).toBe(true);
    return mounted;
  }

  async function scrollDown(): Promise<void> {
    for (let step = 1; step <= STEPS; step++) {
      harness!.scroll(step * ROW);
      await harness!.settle(16);
      harness!.measureUnmeasuredCells(() => ROW);
    }
    await harness!.settle(48);
  }

  it('reorders the children on window steps when the rest gate is off', async () => {
    const mounted = await mountAtRest();
    await scrollDown();
    const moved = cells(harness!);
    expect(root(harness!).props.nativeID).toBe('nitrolist-flow-root');
    expect(ascending(activeIndices(moved))).toBe(true);
    expect(sameRelativeOrder(mounted, moved)).toBe(false);
  });

  it('suspends the flow while the window moves and keeps the child order', async () => {
    NitroListDevFlags.experimentalSlot01 = true;
    const mounted = await mountAtRest();
    expect(mounted.filter((node) => node.props.parked !== true).every((node) => node.props.flow === true)).toBe(true);
    await scrollDown();
    const moved = cells(harness!);
    expect(root(harness!).props.nativeID).toBe('nitrolist-absolute-root');
    expect(moved.some((node) => node.props.flow === true)).toBe(false);
    expect(sameRelativeOrder(mounted, moved)).toBe(true);
    expect(harness!.renderedIndices()).toContain(STEPS + 8);
  });

  it('returns to the flow in index order once the window has rested', async () => {
    NitroListDevFlags.experimentalSlot01 = true;
    await mountAtRest();
    await scrollDown();
    await harness!.settle(FLOW_REST_MS - 100);
    expect(root(harness!).props.nativeID).toBe('nitrolist-absolute-root');
    await harness!.settle(200);
    expect(root(harness!).props.nativeID).toBe('nitrolist-flow-root');
    const rested = cells(harness!);
    const active = rested.filter((node) => node.props.parked !== true);
    expect(ascending(activeIndices(rested))).toBe(true);
    expect(active.every((node) => node.props.flow === true)).toBe(true);
    expect(rested.slice(0, active.length).every((node) => node.props.parked !== true)).toBe(true);
  });

  it('restarts the rest period on every window step', async () => {
    NitroListDevFlags.experimentalSlot01 = true;
    await mountAtRest();
    await scrollDown();
    await harness!.settle(FLOW_REST_MS - 100);
    harness!.scroll((STEPS + 1) * ROW);
    await harness!.settle(16);
    harness!.measureUnmeasuredCells(() => ROW);
    await harness!.settle(FLOW_REST_MS - 100);
    expect(root(harness!).props.nativeID).toBe('nitrolist-absolute-root');
    await harness!.settle(200);
    expect(root(harness!).props.nativeID).toBe('nitrolist-flow-root');
  });
});
