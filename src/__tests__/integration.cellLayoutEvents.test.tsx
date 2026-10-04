import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {StyleSheet, View} from 'react-native';
import type {ReactTestInstance} from 'react-test-renderer';

import {NitroListPerfMonitor} from '../PerfMonitor';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

let harness: NitroListHarness<unknown> | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  harness?.unmount();
  harness = undefined;
  NitroListPerfMonitor.disable();
  jest.useRealTimers();
});

function measuringView(cell: ReactTestInstance): ReactTestInstance {
  const view = cell.findAll((node) => node.type === View && node.props.onLayout != null)[0];
  if (view == null) throw new Error('cell has no measuring view');
  return view;
}

function positionedView(cell: ReactTestInstance): ReactTestInstance {
  return cell.findAll((node) => node.type === View)[0];
}

describe('cell layout events (fronteira 1.5)', () => {
  it('measures on an unpositioned child, so moving a cell does not change the measured frame', async () => {
    harness = renderNitroList<unknown>({
      data: makeItems(20),
      estimatedItemSize: 100,
      keyExtractor: itemKey as (item: unknown) => string,
      renderItem: () => null,
    });
    harness.layout(400, 800);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    const cell = harness.cellInstances().get(1)!;
    const before = measuringView(cell);
    const beforeProps = before.props;
    expect(StyleSheet.flatten(positionedView(cell).props.style)).toMatchObject({top: 100});

    harness.measureCell(0, 250);
    await harness.settle(50);

    const after = harness.cellInstances().get(1)!;
    expect(StyleSheet.flatten(positionedView(after).props.style)).toMatchObject({top: 250});
    const measuring = measuringView(after);
    expect(measuring).not.toBe(positionedView(after));
    expect(measuring.props.collapsable).toBeUndefined();
    const measuringStyle = StyleSheet.flatten(measuring.props.style) ?? {};
    for (const key of ['position', 'top', 'left', 'right', 'bottom']) {
      expect(measuringStyle).not.toHaveProperty(key);
    }
    expect(measuring.props.onLayout).toBe(beforeProps.onLayout);
  });

  it('keeps mounted sizes without a data commit when an in-place change touches only measured cells', async () => {
    const items = Array.from({length: 30}, (_, i) => ({id: `r${i}`, rev: 0}));
    harness = renderNitroList<unknown>(
      {
        data: items,
        estimatedItemSize: 100,
        keyExtractor: (item) => (item as {id: string}).id,
        renderItem: () => null,
      },
      {typeAverages: false},
    );
    harness.layout(400, 800);
    harness.measureUnmeasuredCells(() => 150);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 150);
    await harness.settle(50);
    const mounted = harness.renderedIndices();
    expect(mounted.length).toBeGreaterThan(4);
    const next = items.slice();
    next[2] = {id: 'r2', rev: 1};
    harness.mirror.callLog.length = 0;
    const commitsBefore = harness.mirror.dataCommits.length;

    harness.update({data: next});

    expect(harness.mirror.dataCommits).toHaveLength(commitsBefore);
    for (const index of mounted) expect(harness.handle.getItemSize(index)).toBe(150);
    await harness.settle(50);
    expect(harness.mirror.callLog.filter((call) => call === 'setItemSizesAndFill')).toHaveLength(0);
    for (const index of harness.renderedIndices()) {
      if (mounted.includes(index)) expect(harness.handle.getItemSize(index)).toBe(150);
    }
  });

  it('invalidates from the first changed item that no mounted cell re-supplies', async () => {
    const items = Array.from({length: 30}, (_, i) => ({id: `r${i}`, rev: 0}));
    harness = renderNitroList<unknown>(
      {
        data: items,
        estimatedItemSize: 100,
        keyExtractor: (item) => (item as {id: string}).id,
        renderItem: () => null,
      },
      {typeAverages: false},
    );
    harness.layout(400, 800);
    harness.measureUnmeasuredCells(() => 150);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 150);
    await harness.settle(50);
    const mounted = harness.renderedIndices();
    expect(mounted).not.toContain(25);
    const next = items.slice();
    next[2] = {id: 'r2', rev: 1};
    next[25] = {id: 'r25', rev: 1};

    harness.update({data: next});

    expect(harness.mirror.dataCommits.at(-1)![9]).toBe(25);
    for (const index of mounted) expect(harness.handle.getItemSize(index)).toBe(150);
  });

  it('does not wait for layout events from measured cells whose index shifted', async () => {
    harness = renderNitroList<unknown>({
      data: makeItems(200),
      estimatedItemSize: 100,
      keyExtractor: itemKey as (item: unknown) => string,
      maintainVisibleContentPosition: {data: true},
      renderItem: () => null,
    });
    harness.layout(400, 800);
    harness.measureUnmeasuredCells(() => 100);
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 100);
    await harness.settle(50);
    const before = harness.renderedIndices();
    harness.update({data: [...makeItems(1, 1000), ...makeItems(200)]});
    await harness.settle(50);
    harness.measureUnmeasuredCells(() => 100);
    await harness.settle(50);
    expect(before.length).toBeGreaterThan(3);
    expect(harness.lastScrollTop()).toBe(0);

    NitroListPerfMonitor.enable();
    const landed = harness.handle.scrollToIndex({index: 0, animated: false});
    await harness.settle(200);
    await landed;
    expect(harness.renderedIndices()).toEqual(before);
    const phases = NitroListPerfMonitor.getSnapshot().lastScrollToIndex?.phases ?? '';
    expect(phases).toContain('land');
    expect(phases).not.toMatch(/layout\(\d+\)/);
  });
});
