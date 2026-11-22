import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Platform, ScrollView, StyleSheet, Text} from 'react-native';
import {act, create} from 'react-test-renderer';
import {NitroList} from '../NitroList';

import {createImagePrefetcher} from '../imagePrefetch';
import {resetNativeHostCacheForTests} from '../nativeHost';
import {
  compileNativeTemplate,
  packNativeTemplateChunk,
  resolveNativeImageUri,
  type NativeTemplateConfig,
} from '../nativeTemplate';
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

  it('compiles and packs Level 3 native templates with UTF-8, dedup, numbers, booleans, and nulls', () => {
    type Row = {id: string; title: string; avatar: string; aspect?: number; mine: boolean; photo?: string | null};
    const config: NativeTemplateConfig<Row> = {
      nativeIdPrefix: 'row-',
      getTestId: (item) => item.id,
      getTemplateKey: (item) => (item.photo ? 'photo' : 'post'),
      templates: {
        post: {
          type: 'column',
          padding: 12,
          children: [
            {type: 'image', uriField: 'avatar', width: 40, height: 40, borderRadius: 20},
            {type: 'text', textField: 'title', fontSize: 15, fontWeight: '600'},
          ],
        },
        photo: {
          type: 'column',
          children: [
            {type: 'text', textField: 'title', visibleField: 'showTitle'},
            {type: 'image', uriField: 'photo', aspectRatioField: 'aspect'},
          ],
        },
      },
      extractFields: (item) => ({
        avatar: item.avatar,
        title: item.title,
        photo: item.photo ?? null,
        aspect: item.aspect,
        showTitle: item.mine,
      }),
    };

    const compiled = compileNativeTemplate(config);
    const parsedSchema = JSON.parse(compiled.schemaJson) as Record<string, unknown>;
    expect(parsedSchema.v).toBe(1);
    expect(parsedSchema.nidP).toBe('row-');
    expect(compiled.stringFields).toEqual(['avatar', 'title', 'photo', '$testId']);
    expect(compiled.numberFields).toEqual(['showTitle', 'aspect']);

    const rows: Row[] = [
      {id: 'r0', title: 'Olá ação 🚀', avatar: 'https://cdn/a.png', mine: true, photo: null},
      {id: 'r1', title: 'Olá ação 🚀', avatar: 'https://cdn/a.png', mine: false, photo: 'https://cdn/p.jpg', aspect: 1.5},
    ];
    const buf = packNativeTemplateChunk(rows, 0, rows.length, compiled, config);
    const dv = new DataView(buf);
    expect(dv.getInt32(0, true)).toBe(2); // count
    expect(dv.getInt32(4, true)).toBe(4); // S
    expect(dv.getInt32(8, true)).toBe(2); // F
    const strPoolOffset = dv.getInt32(12, true);
    expect(strPoolOffset).toBeGreaterThan(16);

    const u8 = new Uint8Array(buf);
    expect(u8[16]).toBe(0); // post
    expect(u8[17]).toBe(1); // photo

    const f32 = new Float32Array(buf, 20, 4);
    expect(f32[0]).toBe(1); // row 0 showTitle = true
    expect(Number.isNaN(f32[1])).toBe(true); // row 0 aspect = undefined -> NaN
    expect(f32[2]).toBe(0); // row 1 showTitle = false
    expect(f32[3]).toBeCloseTo(1.5, 5); // row 1 aspect

    // Dedup check: row 0 & row 1 share identical byte offset for 'avatar' and 'title'
    const strTable = new Int32Array(buf, 20 + 16, 16);
    expect(strTable[0]).toBe(strTable[8]); // avatar offset deduped
    expect(strTable[2]).toBe(strTable[10]); // title offset deduped
    expect(strTable[5]).toBe(-1); // row 0 photo is null -> len = -1
    expect(strTable[13]).toBeGreaterThan(0); // row 1 photo present

    // resolveNativeImageUri handles strings & null cleanly
    expect(resolveNativeImageUri('https://cdn/x.png')).toBe('https://cdn/x.png');
    expect(resolveNativeImageUri(null)).toBe('');
  });

  it('activates Level 3 nativeTemplate with on-demand chunking, press routing, and enabled toggle fallback', async () => {
    const renderCalls = jest.fn();
    const onPress = jest.fn();
    const items = makeItems(6000);
    const makeTemplate = (enabled: boolean): NativeTemplateConfig<string> => ({
      enabled,
      nativeIdPrefix: 'tpl-',
      onPress,
      templates: {
        default: {
          type: 'column',
          pressAction: 'open',
          children: [{type: 'text', textField: 'label'}],
        },
      },
      extractFields: (item) => ({label: item}),
    });

    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      estimatedItemSize: 80,
      keyExtractor: itemKey,
      nativeTemplate: makeTemplate(true),
      renderItem: ({item}) => {
        renderCalls(item);
        return <Text>{item}</Text>;
      },
    });
    harness = mounted;
    mounted.layout(360, 640);
    await mounted.settle(50);

    const session = Array.from(getMockNativeHostSessionsForTests().values())[0];
    expect(session).toBeDefined();
    expect(session.templateSchemaJson).not.toBeNull();
    // Zero React renderItem calls while nativeTemplate is active!
    expect(renderCalls).not.toHaveBeenCalled();

    // Large dataset (6000 > 4096): sync head [0..1024) (reset=true) + tail [4976..6000) (reset=false) only!
    expect(session.templateChunks).toHaveLength(2);
    expect(session.templateChunks[0]).toMatchObject({startIndex: 0, count: 1024, totalCount: 6000, reset: true});
    expect(session.templateChunks[1]).toMatchObject({startIndex: 4976, count: 1024, totalCount: 6000, reset: false});

    // Advancing timers does NOT trigger eager background packing!
    await mounted.settle(500);
    expect(session.templateChunks).toHaveLength(2);

    // Native on-demand request pulls exactly the requested middle chunk with reset=false!
    expect(session.onNativeDataRequest).not.toBeNull();
    await act(async () => {
      session.onNativeDataRequest?.(2048, 1024);
    });
    expect(session.templateChunks).toHaveLength(3);
    expect(session.templateChunks[2]).toMatchObject({startIndex: 2048, count: 1024, totalCount: 6000, reset: false});

    // Native press callback routes cleanly to JS onPress
    session.onNativePress?.(42, 'open');
    expect(onPress).toHaveBeenCalledWith(42, 'open');

    // Toggling enabled=false clears native template and falls back cleanly to standard React slots!
    mounted.update({nativeTemplate: makeTemplate(false)});
    await mounted.settle(50);
    expect(session.templateClearCount).toBe(1);
    const initFlags = SLOT_DELTA_FLAG_ACTIVE | SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED;
    await act(async () => {
      session.onSlotRebinds(
        2,
        0,
        1,
        1,
        480000,
        -1,
        0,
        packDeltas([
          {slotId: 0, itemIndex: 0, generation: 1, flags: initFlags},
          {slotId: 1, itemIndex: 1, generation: 2, flags: initFlags},
        ]),
      );
    });
    expect(renderCalls).toHaveBeenCalledWith('item-0');
    expect(renderCalls).toHaveBeenCalledWith('item-1');
  });

  it('supports nativeTemplate on iOS as well as Android', async () => {
    Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true});
    resetNativeHostCacheForTests();
    const items = makeItems(10);
    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      estimatedItemSize: 60,
      keyExtractor: itemKey,
      nativeTemplate: {
        templates: {default: {type: 'text', textField: 't'}},
        extractFields: (item) => ({t: item}),
      },
      renderItem: ({item}) => <Text>{item}</Text>,
    });
    harness = mounted;
    mounted.layout(390, 844);
    await mounted.settle(50);

    const session = Array.from(getMockNativeHostSessionsForTests().values())[0];
    expect(session.templateSchemaJson).not.toBeNull();
    expect(session.templateChunks).toHaveLength(1);
    expect(session.templateChunks[0]).toMatchObject({startIndex: 0, count: 10, totalCount: 10, reset: true});
  });

  it('silences JS scrollEventThrottle on iOS under native host when using default ScrollView without onScroll', async () => {
    Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true});
    resetNativeHostCacheForTests();
    const items = makeItems(30);
    const renderItem = ({item}: {item: string}) => <Text>{item}</Text>;

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <NitroList
          data={items}
          recycleItems
          estimatedItemSize={60}
          keyExtractor={itemKey}
          renderItem={renderItem}
        />,
      );
    });
    const scrollView = tree.root.findByType(ScrollView);
    expect(scrollView.props.scrollEventThrottle).toBe(1_000_000_000);

    const onScroll = jest.fn();
    await act(async () => {
      tree.update(
        <NitroList
          data={items}
          recycleItems
          estimatedItemSize={60}
          keyExtractor={itemKey}
          renderItem={renderItem}
          onScroll={onScroll}
        />,
      );
    });
    expect(scrollView.props.scrollEventThrottle).toBe(16);
    await act(async () => {
      tree.unmount();
    });

    // Custom renderScrollComponent keeps scrollEventThrottle at 16 and forwards user onScroll
    const customOnScroll = jest.fn();
    const mounted = renderNitroList({
      data: items,
      recycleItems: true,
      estimatedItemSize: 60,
      keyExtractor: itemKey,
      renderItem,
      onScroll: customOnScroll,
    });
    harness = mounted;
    mounted.layout(390, 844);
    await mounted.settle(50);
    expect(mounted.scrollProps.scrollEventThrottle).toBe(16);
    mounted.scroll(240);
    expect(customOnScroll).toHaveBeenCalledTimes(1);
  });

  it('uses O(1) shiftNativeTemplateData + incremental packing on pure prepend and append', async () => {
    const initial = makeItems(200);
    const tpl: NativeTemplateConfig<string> = {
      templates: {default: {type: 'text', textField: 't'}},
      extractFields: (item) => ({t: item}),
    };
    const mounted = renderNitroList({
      data: initial,
      recycleItems: true,
      estimatedItemSize: 60,
      keyExtractor: itemKey,
      nativeTemplate: tpl,
      renderItem: ({item}) => <Text>{item}</Text>,
    });
    harness = mounted;
    mounted.layout(360, 640);
    await mounted.settle(50);

    const session = Array.from(getMockNativeHostSessionsForTests().values())[0];
    expect(session.templateChunks).toHaveLength(1);
    expect(session.templateChunks[0]).toMatchObject({startIndex: 0, count: 200, reset: true});

    // Pure prepend of 50 older items: shifts existing 200 items & packs ONLY the 50 new ones!
    const older = Array.from({length: 50}, (_, i) => `older-${i}`);
    const prepended = [...older, ...initial];
    mounted.update({data: prepended});
    await mounted.settle(50);
    expect(session.templateShifts).toEqual([{delta: 50, totalCount: 250}]);
    expect(session.templateChunks).toHaveLength(2);
    expect(session.templateChunks[1]).toMatchObject({startIndex: 0, count: 50, totalCount: 250, reset: false});

    // Pure append of 25 newer items: packs ONLY [250..275) with reset=false!
    const newer = Array.from({length: 25}, (_, i) => `newer-${i}`);
    mounted.update({data: [...prepended, ...newer]});
    await mounted.settle(50);
    expect(session.templateChunks).toHaveLength(3);
    expect(session.templateChunks[2]).toMatchObject({startIndex: 250, count: 25, totalCount: 275, reset: false});
  });
});
