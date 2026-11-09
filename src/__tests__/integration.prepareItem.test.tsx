import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import type {NitroListPrepareItem, NitroListProps, NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const renderItem: NitroListRenderItem<string> = () => <View />;

type Call = {item: string; index: number; key: string; signal: AbortSignal};

describe('prepareItem', () => {
  let harness: NitroListHarness | null = null;

  function render(props: Partial<NitroListProps<string>>): NitroListHarness {
    const next = renderNitroList({
      data: makeItems(200),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      ...props,
    });
    next.layout(400, 600);
    harness = next;
    return next;
  }

  async function idle(list: NitroListHarness): Promise<void> {
    await list.settle(100);
    for (const index of list.renderedIndices()) list.measureCell(index, 100);
    await list.settle(1500);
  }

  function recorder(pending = false): {prepareItem: NitroListPrepareItem<string>; calls: Call[]} {
    const calls: Call[] = [];
    const prepareItem: NitroListPrepareItem<string> = ({item, index, key, signal}) => {
      calls.push({item, index, key, signal});
      return pending ? new Promise<void>(() => {}) : undefined;
    };
    return {prepareItem, calls};
  }

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

  it('prepares the items just past the rendered window once the list is idle', async () => {
    const {prepareItem, calls} = recorder();
    const list = render({recycleItems: true, prepareItem});
    await idle(list);

    const rendered = list.renderedIndices();
    const last = rendered[rendered.length - 1];
    const prepared = calls.map(call => call.index);

    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.length).toBeLessThanOrEqual(32);
    expect(prepared[0]).toBe(last + 1);
    expect(prepared).toEqual(prepared.map((_, offset) => last + 1 + offset));
    expect(calls.every(call => call.item === `item-${call.index}` && call.key === call.item)).toBe(true);
    expect(calls.every(call => !call.signal.aborted)).toBe(true);
  });

  it('does not mount those items ahead of time', async () => {
    const {prepareItem, calls} = recorder();
    const list = render({recycleItems: true, prepareItem});
    await idle(list);

    const rendered = new Set(list.renderedIndices());

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(call => rendered.has(call.index))).toBe(false);
  });

  it('stays idle without recycleItems', async () => {
    const {prepareItem, calls} = recorder();
    const list = render({prepareItem});
    await idle(list);

    expect(calls).toEqual([]);
  });

  it('aborts what is still running when the list unmounts', async () => {
    const {prepareItem, calls} = recorder(true);
    const list = render({recycleItems: true, prepareItem});
    await idle(list);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => !call.signal.aborted)).toBe(true);

    list.unmount();
    harness = null;

    expect(calls.every(call => call.signal.aborted)).toBe(true);
  });

  it('starts over when the data changes', async () => {
    const {prepareItem, calls} = recorder(true);
    const list = render({recycleItems: true, prepareItem});
    await idle(list);
    const first = [...calls];

    expect(first.length).toBeGreaterThan(0);

    list.update({data: makeItems(200, 1000)});
    await idle(list);

    expect(first.every(call => call.signal.aborted)).toBe(true);
  });
});
