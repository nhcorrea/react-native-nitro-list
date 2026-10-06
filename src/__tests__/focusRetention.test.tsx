import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {TextInput} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import {createCellRecord, focusedCellIndex, type CellBridge} from '../cells';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const heightFor = () => 100;

function bridgeWith(records: ReturnType<typeof createCellRecord>[]): CellBridge {
  return {awaitingLayout: 0, followIndex: -1, cells: new Set(records), onLayoutSettled: () => {}, onAutoFixedMismatch: () => {}};
}

describe('focus retention', () => {
  let harness: NitroListHarness | null = null;
  const focused = {tag: 'focused-input'};

  beforeEach(() => {
    jest.useFakeTimers();
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('finds the active cell whose host contains the focused input', () => {
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(focused as never);
    const outside = createCellRecord();
    outside.identity = {index: 3, item: 'a', revision: {} as never, geometry: 0, active: true};
    outside.host = {contains: () => false} as never;
    const inside = createCellRecord();
    inside.identity = {index: 7, item: 'b', revision: {} as never, geometry: 0, active: true};
    inside.host = {contains: (node: unknown) => node === focused} as never;
    expect(focusedCellIndex(bridgeWith([outside, inside]))).toBe(7);
    inside.identity.active = false;
    expect(focusedCellIndex(bridgeWith([outside, inside]))).toBe(-1);
  });

  it('returns -1 without a focused input or without host traversal', () => {
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(null as never);
    const record = createCellRecord();
    record.identity = {index: 1, item: 'a', revision: {} as never, geometry: 0, active: true};
    record.host = {contains: () => true} as never;
    expect(focusedCellIndex(bridgeWith([record]))).toBe(-1);
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(focused as never);
    record.host = {} as never;
    expect(focusedCellIndex(bridgeWith([record]))).toBe(-1);
  });

  it('keeps the focused item rendered after it leaves the window', async () => {
    harness = renderNitroList({data: makeItems(500), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey, recycleItems: true});
    harness.layout(400, 800);
    harness.measureUnmeasuredCells(heightFor);
    await harness.settle(50);
    const target = 2;
    const cell = harness.cellInstances().get(target)!;
    const host = cell.findAll((node) => node.props?.onLayout != null)[0];
    expect(host).toBeDefined();
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(focused as never);
    const records = (harness as unknown as {renderer: {root: {findAll: (p: (n: {props?: {cellBridge?: CellBridge}}) => boolean) => Array<{props: {cellBridge: CellBridge}}>}}}).renderer.root
      .findAll((node) => node.props?.cellBridge != null)[0].props.cellBridge;
    for (const record of records.cells) {
      record.host = {contains: (node: unknown) => node === focused && record.identity?.index === target} as never;
    }
    for (const offset of [1000, 3000, 6000, 12000]) {
      harness.scroll(offset);
      await harness.settle(16);
      harness.measureUnmeasuredCells(heightFor);
    }
    await harness.settle(50);
    expect(harness.renderedIndices()).toContain(target);
  });
});
