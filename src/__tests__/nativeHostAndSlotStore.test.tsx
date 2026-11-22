import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Platform, StyleSheet, Text} from 'react-native';
import {act} from 'react-test-renderer';

import {createImagePrefetcher} from '../imagePrefetch';
import {resetNativeHostCacheForTests} from '../nativeHost';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {
  SLOT_DELTA_FLAG_ACTIVE,
  SLOT_DELTA_FLAG_CREATED,
  SLOT_DELTA_FLAG_ITEM_CHANGED,
  SlotStore,
} from '../slotStore';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {
  getMockCancelPrefetchCountForTests,
  getMockNativeHostSessionsForTests,
  getMockPrefetchCallsForTests,
  resetMockNativeHostForTests,
  setNativeHostMockEnabledForTests,
} from './helpers/mockNitroModules';

function packDeltas(
  deltas: ReadonlyArray<{slotId: number; itemIndex: number; generation: number; flags: number}>,
): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(4, deltas.length * 16));
  const ints = new Int32Array(buf);
  for (let i = 0; i < deltas.length; i++) {
    ints[i * 4 + 0] = deltas[i].slotId;
    ints[i * 4 + 1] = deltas[i].itemIndex;
    ints[i * 4 + 2] = deltas[i].generation;
    ints[i * 4 + 3] = deltas[i].flags;
  }
  return buf;
}

describe('SlotStore delta subscriptions', () => {
  it('notifies slotCount only when slot pool grows and notifies only rebound slots', () => {
    const store = new SlotStore();
    let countNotifies = 0;
    const slotNotifies = new Map<number, number>();
    store.subscribeSlotCount(() => countNotifies++);
    for (let s = 0; s < 4; s++) {
      slotNotifies.set(s, 0);
      store.subscribeSlot(s, () => slotNotifies.set(s, (slotNotifies.get(s) ?? 0) + 1));
    }

    // Initial mount: 4 slots created
    const initialFlags = SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED;
    const n1 = store.applyNativeDeltas(
      4,
      packDeltas([
        {slotId: 0, itemIndex: 0, generation: 1, flags: initialFlags},
        {slotId: 1, itemIndex: 1, generation: 2, flags: initialFlags},
        {slotId: 2, itemIndex: 2, generation: 3, flags: initialFlags},
        {slotId: 3, itemIndex: 3, generation: 4, flags: initialFlags},
      ]),
    );
    expect(countNotifies).toBe(1);
    expect(n1).toBe(4);
    expect(store.getSlotCount()).toBe(4);

    // Steady-state scroll: only slot 0 rebinds to item 4; slots 1..3 untouched
    countNotifies = 0;
    slotNotifies.forEach((_, k) => slotNotifies.set(k, 0));
    const n2 = store.applyNativeDeltas(
      4,
      packDeltas([
        {
          slotId: 0,
          itemIndex: 4,
          generation: 5,
          flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_ITEM_CHANGED,
        },
      ]),
    );
    expect(countNotifies).toBe(0);
    expect(n2).toBe(1);
    expect(slotNotifies.get(0)).toBe(1);
    expect(slotNotifies.get(1)).toBe(0);
    expect(slotNotifies.get(2)).toBe(0);
    expect(slotNotifies.get(3)).toBe(0);

    // Parking slot 1 (active=false, itemChanged=false): ZERO React notifications!
    const n3 = store.applyNativeDeltas(
      4,
      packDeltas([{slotId: 1, itemIndex: -1, generation: 2, flags: 0}]),
    );
    expect(countNotifies).toBe(0);
    expect(n3).toBe(0);
    expect(slotNotifies.get(1)).toBe(0);
    expect(store.getSlot(1).active).toBe(false);
    expect(store.getSlot(1).itemIndex).toBe(1); // preserved for affinity
  });
});

describe('ImagePrefetcher', () => {
  beforeEach(() => {
    setNativeHostMockEnabledForTests(true);
    resetNativeHostCacheForTests();
  });

  afterEach(() => {
    resetMockNativeHostForTests();
    resetNativeHostCacheForTests();
  });

  it('prefetches lookahead URIs in scroll direction, deduplicates, and cancels on direction reversal', () => {
    const items = makeItems(50);
    const prefetcher = createImagePrefetcher<string>();
    const getUris = (_item: string, index: number) => `https://cdn.example.com/img-${index}.jpg`;

    // Scrolling down from range [0..5] -> prefetches [6..9]
    prefetcher.onRange(items, 0, 5, 500, getUris, {lookaheadItems: 4, width: 100, height: 100});
    expect(getMockPrefetchCallsForTests()).toHaveLength(1);
    expect(getMockPrefetchCallsForTests()[0].uris).toEqual([
      'https://cdn.example.com/img-6.jpg',
      'https://cdn.example.com/img-7.jpg',
      'https://cdn.example.com/img-8.jpg',
      'https://cdn.example.com/img-9.jpg',
    ]);
    expect(getMockPrefetchCallsForTests()[0].widthPx).toBeGreaterThan(0);

    // Advancing slightly [2..7] -> only new URIs [10..11] prefetched (8,9 deduplicated!)
    prefetcher.onRange(items, 2, 7, 500, getUris, {lookaheadItems: 4});
    expect(getMockPrefetchCallsForTests()).toHaveLength(2);
    expect(getMockPrefetchCallsForTests()[1].uris).toEqual([
      'https://cdn.example.com/img-10.jpg',
      'https://cdn.example.com/img-11.jpg',
    ]);
    expect(getMockCancelPrefetchCountForTests()).toBe(0);

    // Reversing direction (scrolling up) -> cancels in-flight fetches & prefetches behind!
    prefetcher.onRange(items, 5, 10, -600, getUris, {lookaheadItems: 3});
    expect(getMockCancelPrefetchCountForTests()).toBe(1);
    expect(getMockPrefetchCallsForTests()).toHaveLength(3);
    expect(getMockPrefetchCallsForTests()[2].uris).toEqual([
      'https://cdn.example.com/img-2.jpg',
      'https://cdn.example.com/img-3.jpg',
      'https://cdn.example.com/img-4.jpg',
    ]);
  });
});

describe('NitroList Native Host + NitroListSlots integration', () => {
  const originalOS = Platform.OS;
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true});
    setNativeHostMockEnabledForTests(true);
    resetNativeHostCacheForTests();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListPerfMonitor.disable();
    resetMockNativeHostForTests();
    resetNativeHostCacheForTests();
    Object.defineProperty(Platform, 'OS', {value: originalOS, configurable: true});
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('mounts zero-parent-rerender delta slots with 1 View per cell and silences JS scroll when no onScroll prop', async () => {
    const renderCalls = new Map<number, number>();
    const items = makeItems(100);
    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      estimatedItemSize: 80,
      keyExtractor: itemKey,
      getImageUris: (_item, index) => `https://img/${index}.png`,
      imagePrefetchConfig: {lookaheadItems: 3, width: 80, height: 80},
      renderItem: ({item, index}) => {
        renderCalls.set(index, (renderCalls.get(index) ?? 0) + 1);
        return <Text>{item}</Text>;
      },
    });
    harness = mounted;
    mounted.layout(360, 640);
    await mounted.settle(50);

    const sessions = Array.from(getMockNativeHostSessionsForTests().values());
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.detached).toBe(false);
    expect(session.userHasOnScroll).toBe(false);

    // Emit initial 6 slots from native host
    const initFlags = SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED;
    await act(async () => {
      session.onSlotRebinds(
        6,
        0,
        5,
        1,
        8000,
        -1,
        0,
        packDeltas(
          Array.from({length: 6}, (_, s) => ({
            slotId: s,
            itemIndex: s,
            generation: s + 1,
            flags: initFlags,
          })),
        ),
      );
    });

    // Verify 1 single host <View> per slot with nativeID="nl:<gen>" and NO onLayout prop!
    const slotViews = mounted.renderer.root.findAll(
      (node) =>
        (node.type as unknown) === 'View' &&
        typeof node.props.nativeID === 'string' &&
        node.props.nativeID.startsWith('nl:'),
    );
    expect(slotViews).toHaveLength(6);
    for (let s = 0; s < 6; s++) {
      expect(slotViews[s].props.nativeID).toBe(`nl:${s + 1}`);
      expect(slotViews[s].props.onLayout).toBeUndefined();
      const flat = StyleSheet.flatten(slotViews[s].props.style) as Record<string, unknown>;
      expect(flat.position).toBe('absolute');
      expect(flat.top).toBe(-10000);
    }

    // Now measure steady-state delta scroll: only 2 slots rebind (slot 0 -> item 6, slot 1 -> item 7)
    renderCalls.clear();
    NitroListPerfMonitor.enable();
    await act(async () => {
      session.onSlotRebinds(
        6,
        2,
        7,
        1,
        8000,
        -1,
        600,
        packDeltas([
          {
            slotId: 0,
            itemIndex: 6,
            generation: 7,
            flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_ITEM_CHANGED,
          },
          {
            slotId: 1,
            itemIndex: 7,
            generation: 8,
            flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_ITEM_CHANGED,
          },
        ]),
      );
    });
    const snap = NitroListPerfMonitor.getSnapshot();
    NitroListPerfMonitor.disable();

    // KEY LEVEL 1 INVARIANT: ZERO parent container re-renders, ONLY 2 slot re-renders!
    expect(snap.cellsRenders).toBe(0);
    expect(snap.itemRenders).toBe(2);
    expect(renderCalls.size).toBe(2);
    expect(renderCalls.get(6)).toBe(1);
    expect(renderCalls.get(7)).toBe(1);

    // Native contentSize update does NOT re-render NitroListSlots or any slot!
    NitroListPerfMonitor.enable();
    await act(async () => {
      session.onContentSize(8240, 2);
    });
    const snapSize = NitroListPerfMonitor.getSnapshot();
    NitroListPerfMonitor.disable();
    expect(snapSize.cellsRenders).toBe(0);
    expect(snapSize.itemRenders).toBe(0);

    // Level 2 image prefetch fired automatically ahead of range [2..7] -> [8, 9, 10]!
    expect(getMockPrefetchCallsForTests().some((call) => call.uris.includes('https://img/8.png'))).toBe(
      true,
    );

    // Adding user onScroll flips userHasOnScroll -> true on native host
    mounted.update({onScroll: () => {}});
    await mounted.settle(20);
    expect(session.userHasOnScroll).toBe(true);

    // Unmount detaches native host & cancels image prefetch cleanly
    mounted.unmount();
    harness = null;
    expect(session.detached).toBe(true);
    expect(getMockCancelPrefetchCountForTests()).toBeGreaterThanOrEqual(1);
  });

  it('uses NativeHostStickySlot when stickyHeaderIndices is configured under native host', async () => {
    const items = makeItems(40);
    const onChangeStickyIndex = jest.fn();
    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      estimatedItemSize: 60,
      stickyHeaderIndices: [0, 10, 20],
      onChangeStickyIndex,
      renderItem: ({item, target}) => <Text>{`${target}:${item}`}</Text>,
    });
    harness = mounted;
    mounted.layout(360, 600);
    await mounted.settle(50);

    const session = Array.from(getMockNativeHostSessionsForTests().values())[0];
    expect(session).toBeDefined();

    await act(async () => {
      session.onSlotRebinds(
        4,
        0,
        3,
        1,
        2400,
        10,
        0,
        packDeltas(
          Array.from({length: 4}, (_, s) => ({
            slotId: s,
            itemIndex: s,
            generation: s + 1,
            flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED,
          })),
        ),
      );
    });

    expect(onChangeStickyIndex).toHaveBeenCalledWith(10);
    const stickyText = mounted.renderer.root.findAll(
      (node) => node.type === Text && node.props.children === 'StickyHeader:item-10',
    );
    expect(stickyText).toHaveLength(1);
  });

  it('keeps inner crossAxisGap wrapper ONLY for grids with crossAxisGap > 0', async () => {
    const items = makeItems(20);
    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      numColumns: 2,
      columnWrapperStyle: {columnGap: 16},
      estimatedItemSize: 100,
      renderItem: ({item}) => <Text>{item}</Text>,
    });
    harness = mounted;
    mounted.layout(360, 600);
    await mounted.settle(50);

    const session = Array.from(getMockNativeHostSessionsForTests().values())[0];
    await act(async () => {
      session.onSlotRebinds(
        2,
        0,
        1,
        1,
        1000,
        -1,
        0,
        packDeltas([
          {
            slotId: 0,
            itemIndex: 0,
            generation: 1,
            flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED,
          },
          {
            slotId: 1,
            itemIndex: 1,
            generation: 2,
            flags: SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED,
          },
        ]),
      );
    });

    const slotViews = mounted.renderer.root.findAll(
      (node) =>
        (node.type as unknown) === 'View' &&
        typeof node.props.nativeID === 'string' &&
        node.props.nativeID.startsWith('nl:'),
    );
    expect(slotViews).toHaveLength(2);
    // Outer slot has percentage width/left, inner View carries paddingLeft/paddingRight = 8
    const outerStyle = StyleSheet.flatten(slotViews[0].props.style) as Record<string, unknown>;
    expect(outerStyle.width).toBe('50%');
    expect(outerStyle.paddingLeft).toBeUndefined();
    const innerViews = slotViews[0].findAll((n) => (n.type as unknown) === 'View');
    const innerStyle = StyleSheet.flatten(innerViews[1].props.style) as Record<string, unknown>;
    expect(innerStyle.paddingLeft).toBe(8);
    expect(innerStyle.paddingRight).toBe(8);
  });
});
