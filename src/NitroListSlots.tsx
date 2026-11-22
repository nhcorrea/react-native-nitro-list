import React, {useCallback, useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {findNodeHandle, StyleSheet, View, type LayoutChangeEvent} from 'react-native';

import {NitroListCellContent, type ItemsAreEqualFn, type ItemTypeKey} from './cells';
import {ListStore, useStoreValue} from './listStore';
import {
  registerNativeSlotView,
  setNativeSlotMeasures,
  setNativeStickyViewTag,
  unregisterNativeSlotView,
} from './nativeHost';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import type {SlotSnapshot, SlotStore} from './slotStore';
import type {NitroListRenderItem, NitroListRenderMode} from './types';

export interface NitroListSlotsSharedContext {
  items: ReadonlyArray<unknown>;
  itemCount: number;
  dataVersion: unknown;
  horizontal: boolean;
  resolvedColumns: number;
  columnLayout: {
    spans: Uint16Array;
    colOf: Uint16Array;
  } | null;
  crossAxisGap: number;
  renderItem: NitroListRenderItem<unknown>;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  getItemType?: (item: unknown, index: number) => ItemTypeKey;
  getFixedItemSize?: (
    item: unknown,
    index: number,
    type: ItemTypeKey | undefined,
  ) => number | undefined;
  itemsAreEqual?: ItemsAreEqualFn;
  adaptiveRenderMode: boolean;
  hideRelatedCell: boolean;
  store: ListStore;
  hostIdRef: {current: number};
}

export interface NitroListSlotsProps {
  slotStore: SlotStore;
  ctxRef: {current: NitroListSlotsSharedContext};
  onSlotsCommit?: (slotCount: number) => void;
}

interface NitroListSlotProps {
  slotId: number;
  slotStore: SlotStore;
  ctxRef: {current: NitroListSlotsSharedContext};
}

const NitroListSlot = React.memo(function NitroListSlot({
  slotId,
  slotStore,
  ctxRef,
}: NitroListSlotProps) {
  const subscribeSlot = useCallback(
    (listener: () => void) => slotStore.subscribeSlot(slotId, listener),
    [slotStore, slotId],
  );
  const readSlot = useCallback((): SlotSnapshot => slotStore.getSlot(slotId), [slotStore, slotId]);
  const slot = useSyncExternalStore(subscribeSlot, readSlot, readSlot);

  const ctx = ctxRef.current;
  const subscribeRenderMode = useCallback(
    (listener: () => void) =>
      ctx.adaptiveRenderMode ? ctx.store.subscribe('renderMode', listener) : () => {},
    [ctx.adaptiveRenderMode, ctx.store],
  );
  const readRenderMode = useCallback(
    (): NitroListRenderMode => (ctx.adaptiveRenderMode ? ctx.store.get('renderMode') : 'normal'),
    [ctx.adaptiveRenderMode, ctx.store],
  );
  const renderMode = useSyncExternalStore(subscribeRenderMode, readRenderMode, readRenderMode);

  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemRender();
  }

  const itemIndex = slot.itemIndex;
  const validIndex = itemIndex >= 0 && itemIndex < ctx.itemCount;
  const item = validIndex ? ctx.items[itemIndex] : undefined;
  const itemType = validIndex && ctx.getItemType != null ? ctx.getItemType(item, itemIndex) : undefined;
  const fixedSize =
    validIndex && ctx.getFixedItemSize != null
      ? ctx.getFixedItemSize(item, itemIndex, itemType)
      : undefined;
  const measures = fixedSize == null;

  const registeredTagRef = useRef<number>(-1);
  const registeredHostIdRef = useRef<number>(-1);
  const measuresRef = useRef<boolean>(measures);

  useEffect(() => {
    if (measuresRef.current !== measures) {
      measuresRef.current = measures;
      const hostId = ctxRef.current.hostIdRef.current;
      if (hostId > 0) {
        setNativeSlotMeasures(hostId, slotId, measures);
      }
    }
  }, [measures, slotId, ctxRef]);

  const attachSlotView = useCallback(
    (view: View | null) => {
      const hostId = ctxRef.current.hostIdRef.current;
      if (view == null) {
        if (registeredTagRef.current > 0 && hostId > 0) {
          unregisterNativeSlotView(hostId, slotId);
        }
        registeredTagRef.current = -1;
        registeredHostIdRef.current = -1;
        return;
      }
      const tag = findNodeHandle(view);
      if (tag != null && tag > 0 && (tag !== registeredTagRef.current || hostId !== registeredHostIdRef.current)) {
        registeredTagRef.current = tag;
        if (hostId > 0) {
          registeredHostIdRef.current = hostId;
          registerNativeSlotView(hostId, slotId, tag, measuresRef.current);
        } else {
          registeredHostIdRef.current = -1;
        }
      }
    },
    [slotId, ctxRef],
  );

  // Re-register ONLY if hostId became available after ref attachment (avoids duplicate JSI/UI posts!).
  useEffect(() => {
    const hostId = ctxRef.current.hostIdRef.current;
    const tag = registeredTagRef.current;
    if (hostId > 0 && tag > 0 && registeredHostIdRef.current !== hostId) {
      registeredHostIdRef.current = hostId;
      registerNativeSlotView(hostId, slotId, tag, measuresRef.current);
    }
    return () => {
      const currentHost = ctxRef.current.hostIdRef.current;
      if (currentHost > 0 && registeredHostIdRef.current === currentHost) {
        unregisterNativeSlotView(currentHost, slotId);
      }
      registeredHostIdRef.current = -1;
    };
  }, [slotId, ctxRef]);

  const columnLeft =
    validIndex && ctx.columnLayout != null && ctx.resolvedColumns > 1
      ? `${(ctx.columnLayout.colOf[itemIndex] / ctx.resolvedColumns) * 100}%`
      : undefined;
  const columnWidth =
    validIndex && ctx.columnLayout != null && ctx.resolvedColumns > 1
      ? `${(ctx.columnLayout.spans[itemIndex] / ctx.resolvedColumns) * 100}%`
      : undefined;

  const slotStyle = useMemo(() => {
    if (columnLeft != null && columnWidth != null) {
      return [
        slotStyles.absoluteGridCell,
        {left: columnLeft as unknown as number, width: columnWidth as unknown as number},
      ];
    }
    return ctx.horizontal ? slotStyles.absoluteColumn : slotStyles.absoluteRow;
  }, [ctx.horizontal, columnLeft, columnWidth]);

  const nativeId = slot.generation > 0 ? `nl:${slot.generation}` : undefined;

  const content = validIndex ? (
    <NitroListCellContent
      dataVersion={ctx.dataVersion}
      index={itemIndex}
      item={item}
      renderItem={ctx.renderItem}
      SeparatorComponent={ctx.ItemSeparatorComponent}
      isLastItem={itemIndex === ctx.itemCount - 1}
      renderMode={renderMode}
      itemsAreEqual={ctx.itemsAreEqual}
    />
  ) : null;

  // Grid cells with crossAxisGap > 0 keep an inner padding wrapper so absolute-positioned user
  // children are never shifted by crossAxisGap / 2. All single-column & zero-gap cells render
  // 1 SINGLE <View> (50% fewer native views and Yoga nodes!).
  if (columnLeft != null && columnWidth != null && ctx.crossAxisGap > 0) {
    return (
      <View ref={attachSlotView} collapsable={false} nativeID={nativeId} style={slotStyle}>
        <View
          style={{
            paddingLeft: ctx.crossAxisGap / 2,
            paddingRight: ctx.crossAxisGap / 2,
          }}>
          {content}
        </View>
      </View>
    );
  }

  return (
    <View ref={attachSlotView} collapsable={false} nativeID={nativeId} style={slotStyle}>
      {content}
    </View>
  );
});

/**
 * Delta-reconciled recycled slot container.
 * Subscribes ONLY to `slotCount` — zero parent re-renders during steady-state scrolling or resize!
 */
export const NitroListSlots = React.memo(function NitroListSlots({
  slotStore,
  ctxRef,
  onSlotsCommit,
}: NitroListSlotsProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordCellsRender();
  }
  const subscribeCount = useCallback(
    (listener: () => void) => slotStore.subscribeSlotCount(listener),
    [slotStore],
  );
  const readCount = useCallback(() => slotStore.getSlotCount(), [slotStore]);
  const slotCount = useSyncExternalStore(subscribeCount, readCount, readCount);

  useEffect(() => {
    if (slotCount > 0) {
      onSlotsCommit?.(slotCount);
    }
  }, [slotCount, onSlotsCommit]);

  const children = useMemo(() => {
    const out = new Array<React.ReactElement>(slotCount);
    for (let slotId = 0; slotId < slotCount; slotId++) {
      out[slotId] = (
        <NitroListSlot key={`ns-${slotId}`} slotId={slotId} slotStore={slotStore} ctxRef={ctxRef} />
      );
    }
    return out;
  }, [slotCount, slotStore, ctxRef]);

  return (
    <View collapsable={false} style={slotStyles.container}>
      {children}
    </View>
  );
});

/**
 * Native-Host-driven Sticky Header overlay.
 * UI thread directly updates `translationY`/`translationX` & visibility on every scroll frame
 * with 0.0 dp tracking error and zero Animated.Value / JS onScroll overhead.
 */
export const NativeHostStickySlot = React.memo(function NativeHostStickySlot({
  store,
  items,
  itemCount,
  renderItem,
  adaptiveRenderMode,
  horizontal,
  hostIdRef,
  onLayout,
}: {
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  renderItem: NitroListRenderItem<unknown>;
  adaptiveRenderMode: boolean;
  horizontal: boolean;
  hostIdRef: {current: number};
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const stickyIndex = useStoreValue(store, 'stickyIndex');
  const renderMode = useStoreValue(store, 'renderMode');
  const tagRef = useRef<number>(-1);

  const attachSticky = useCallback(
    (view: View | null) => {
      const hostId = hostIdRef.current;
      if (view == null) {
        if (tagRef.current > 0 && hostId > 0) setNativeStickyViewTag(hostId, -1);
        tagRef.current = -1;
        return;
      }
      const tag = findNodeHandle(view);
      if (tag != null && tag > 0 && tag !== tagRef.current) {
        tagRef.current = tag;
        if (hostId > 0) setNativeStickyViewTag(hostId, tag);
      }
    },
    [hostIdRef],
  );

  const stickyItem = stickyIndex >= 0 && stickyIndex < itemCount ? items[stickyIndex] : undefined;
  if (stickyItem === undefined) return null;

  return (
    <View
      ref={attachSticky}
      pointerEvents="box-none"
      collapsable={false}
      onLayout={onLayout}
      style={horizontal ? slotStyles.stickyHorizontal : slotStyles.stickyVertical}>
      {renderItem({
        item: stickyItem,
        index: stickyIndex,
        target: 'StickyHeader',
        renderMode: adaptiveRenderMode ? renderMode : 'normal',
      })}
    </View>
  );
});

const slotStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  absoluteRow: {
    position: 'absolute',
    top: -10000,
    left: 0,
    right: 0,
  },
  absoluteColumn: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -10000,
  },
  absoluteGridCell: {
    position: 'absolute',
    top: -10000,
  },
  stickyVertical: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  stickyHorizontal: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
});
