import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {PixelRatio, StyleSheet, View, type LayoutChangeEvent} from 'react-native';
import Animated, {useAnimatedStyle, type SharedValue} from 'react-native-reanimated';

import {checkDuplicateKeyDev, warnDevOnce} from './devWarnings';
import {ListStore, useStoreValue, type RangeState} from './listStore';
import {MVCP_ANCHOR_BASE} from './mvcp';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import type {
  NitroListAlwaysRenderConfig,
  NitroListRenderItem,
  NitroListRenderMode,
} from './NitroList';

export type ItemTypeKey = string | number;

export type RenderRange = {
  start: number;
  end: number;
};

export type CellBridge = {
  awaitingLayout: number;
  onLayoutSettled: () => void;
  onAutoFixedMismatch: (index: number, sizeDp: number) => void;
};

export function pushRenderRange(
  ranges: RenderRange[],
  range: RenderRange | null | undefined,
  itemCount: number,
) {
  if (!range || range.end < range.start || itemCount <= 0) return;
  ranges.push({
    start: Math.max(0, range.start),
    end: Math.min(range.end, itemCount - 1),
  });
}

export function mergeRenderRanges(ranges: RenderRange[]): RenderRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const merged: RenderRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({...range});
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export type ItemsAreEqualFn = (prev: unknown, next: unknown, index: number) => boolean;

export interface NitroListCellsProps {
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  keyExtractor?: (item: unknown, index: number) => string;
  getItemType?: (item: unknown, index: number) => ItemTypeKey;
  getFixedItemSize?: (item: unknown, index: number, type: ItemTypeKey | undefined) => number | undefined;
  alwaysRender?: NitroListAlwaysRenderConfig;
  alwaysRenderKeyIndices: number[] | null;
  anchoredEndSpaceAnchor: number | null;
  adaptiveRenderMode: boolean;
  hideRelatedCell: boolean;
  horizontal: boolean;
  columnLayout: {spans: Uint16Array; colOf: Uint16Array; rowStarts: Int32Array} | null;
  resolvedColumns: number;
  mainAxisGap: number;
  crossAxisGap: number;
  renderItem: NitroListRenderItem<unknown>;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  enqueueItemSize: (index: number, sizeDp: number) => void;
  cellBridge: CellBridge;
  itemsAreEqual?: ItemsAreEqualFn;
  readItemOffset: (index: number) => number;
  onCommit: (range: RangeState, prewarmRange: RangeState | null, phase: 'layout' | 'passive') => void;
}

export const NitroListCells = React.memo(function NitroListCells({
  store,
  items,
  itemCount,
  keyExtractor,
  getItemType,
  getFixedItemSize,
  alwaysRender,
  alwaysRenderKeyIndices,
  anchoredEndSpaceAnchor,
  adaptiveRenderMode,
  hideRelatedCell,
  horizontal,
  columnLayout,
  resolvedColumns,
  mainAxisGap,
  crossAxisGap,
  renderItem,
  ItemSeparatorComponent,
  enqueueItemSize,
  cellBridge,
  itemsAreEqual,
  readItemOffset,
  onCommit,
}: NitroListCellsProps) {
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordCellsRender();
  const range = useStoreValue(store, 'range');
  const prewarmRange = useStoreValue(store, 'prewarmRange');
  const stickyIndex = useStoreValue(store, 'stickyIndex');
  const autoFixedTypes = useStoreValue(store, 'autoFixedTypes');
  const renderMode = useStoreValue(store, 'renderMode');
  useLayoutEffect(() => {
    onCommit(range, prewarmRange, 'layout');
  }, [range, prewarmRange, onCommit]);
  useEffect(() => {
    onCommit(range, prewarmRange, 'passive');
  }, [range, prewarmRange, onCommit]);

  const renderedChildren: React.ReactNode[] = [];
  const renderRanges: RenderRange[] = [];
  pushRenderRange(renderRanges, range, itemCount);
  pushRenderRange(renderRanges, prewarmRange, itemCount);
  if (alwaysRender != null && itemCount > 0) {
    if (alwaysRender.top != null && alwaysRender.top > 0) {
      pushRenderRange(renderRanges, {start: 0, end: alwaysRender.top - 1}, itemCount);
    }
    if (alwaysRender.bottom != null && alwaysRender.bottom > 0) {
      pushRenderRange(
        renderRanges,
        {start: itemCount - alwaysRender.bottom, end: itemCount - 1},
        itemCount,
      );
    }
    if (alwaysRender.indices != null) {
      for (const index of alwaysRender.indices) {
        pushRenderRange(renderRanges, {start: index, end: index}, itemCount);
      }
    }
    if (alwaysRenderKeyIndices != null) {
      for (const index of alwaysRenderKeyIndices) {
        pushRenderRange(renderRanges, {start: index, end: index}, itemCount);
      }
    }
  }
  if (anchoredEndSpaceAnchor != null && itemCount > 0) {
    pushRenderRange(
      renderRanges,
      {
        start: Math.max(0, Math.min(anchoredEndSpaceAnchor, itemCount - 1)),
        end: itemCount - 1,
      },
      itemCount,
    );
  }

  const effectiveRenderMode: NitroListRenderMode =
    adaptiveRenderMode ? renderMode : 'normal';
  const seenRenderKeys = IS_DEV ? new Set<string>() : null;
  for (const {start, end} of mergeRenderRanges(renderRanges)) {
    for (let i = start; i <= end; i++) {
      const item = items[i];
      const itemKey = keyExtractor ? keyExtractor(item, i) : String(i);
      if (seenRenderKeys != null) checkDuplicateKeyDev(seenRenderKeys, itemKey);
      const itemType = getItemType ? getItemType(item, i) : undefined;
      const reactKey = itemType !== undefined ? `${itemType}:${itemKey}` : itemKey;
      const explicitFixedSize = getFixedItemSize?.(item, i, itemType);
      if (NITRO_LIST_PERF_COMPILED) {
        NitroListPerfMonitor.recordUserCallbacks(
          (keyExtractor != null ? 1 : 0) +
            (getItemType != null ? 1 : 0) +
            (getFixedItemSize != null ? 1 : 0),
        );
      }
      const autoFixedSize =
        explicitFixedSize == null && autoFixedTypes != null && itemType !== undefined
          ? autoFixedTypes.get(itemType)
          : undefined;
      const top = readItemOffset(i);
      renderedChildren.push(
        <NitroListItemContainer
          key={reactKey}
          index={i}
          top={top}
          horizontal={horizontal}
          hidden={hideRelatedCell && i === stickyIndex}
          columnLeft={
            columnLayout != null
              ? `${(columnLayout.colOf[i] / resolvedColumns) * 100}%`
              : undefined
          }
          columnWidth={
            columnLayout != null
              ? `${(columnLayout.spans[i] / resolvedColumns) * 100}%`
              : undefined
          }
          mainAxisGap={mainAxisGap}
          crossAxisGap={crossAxisGap}
          renderMode={effectiveRenderMode}
          item={item as unknown}
          renderItem={renderItem as NitroListRenderItem<unknown>}
          SeparatorComponent={
            ItemSeparatorComponent as React.ComponentType<{leadingItem: unknown}> | undefined
          }
          isLastItem={i === itemCount - 1}
          enqueueItemSize={enqueueItemSize}
          fixedSize={explicitFixedSize}
          autoFixedSize={autoFixedSize}
          cellBridge={cellBridge}
          itemsAreEqual={itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined}
        />,
      );
    }
  }

  return <>{renderedChildren}</>;
});

export function ListContainer({
  store,
  horizontal,
  children,
}: {
  store: ListStore;
  horizontal: boolean;
  children: React.ReactNode;
}) {
  const totalSize = useStoreValue(store, 'totalSize');
  return (
    <View collapsable={false} style={horizontal ? {width: totalSize} : {height: totalSize}}>
      {children}
    </View>
  );
}

export function EndSpaceSpacer({store, horizontal}: {store: ListStore; horizontal: boolean}) {
  const endSpace = useStoreValue(store, 'endSpace');
  if (endSpace <= 0) return null;
  return <View style={horizontal ? {width: endSpace} : {height: endSpace}} />;
}

export function StickyHeaderSlot({
  store,
  items,
  itemCount,
  renderItem,
  adaptiveRenderMode,
  translateY,
  horizontal,
  onLayout,
}: {
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  renderItem: NitroListRenderItem<unknown>;
  adaptiveRenderMode: boolean;
  translateY: SharedValue<number>;
  horizontal: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const stickyIndex = useStoreValue(store, 'stickyIndex');
  const renderMode = useStoreValue(store, 'renderMode');
  const stickyItem = stickyIndex >= 0 && stickyIndex < itemCount ? items[stickyIndex] : undefined;
  if (stickyItem === undefined) return null;
  return (
    <StickyOverlay translateY={translateY} horizontal={horizontal} onLayout={onLayout}>
      {renderItem({
        item: stickyItem,
        index: stickyIndex,
        target: 'StickyHeader',
        renderMode: adaptiveRenderMode ? renderMode : 'normal',
      })}
    </StickyOverlay>
  );
}

export interface NitroListItemContainerProps {
  index: number;
  top: number;
  horizontal: boolean;
  hidden: boolean;
  columnLeft?: string;
  columnWidth?: string;
  mainAxisGap: number;
  crossAxisGap: number;
  renderMode: NitroListRenderMode;
  item: unknown;
  renderItem: NitroListRenderItem<unknown>;
  SeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  isLastItem: boolean;
  enqueueItemSize: (index: number, sizeDp: number) => void;
  fixedSize?: number;
  autoFixedSize?: number;
  cellBridge: CellBridge;
  itemsAreEqual?: ItemsAreEqualFn;
}

export function areItemsEquivalent(
  prevItem: unknown,
  nextItem: unknown,
  index: number,
  prevFn: ItemsAreEqualFn | undefined,
  nextFn: ItemsAreEqualFn | undefined,
): boolean {
  if (prevItem === nextItem) return true;
  return prevFn != null && prevFn === nextFn && prevFn(prevItem, nextItem, index);
}

export function areItemContainerPropsEqual(
  prev: NitroListItemContainerProps,
  next: NitroListItemContainerProps,
): boolean {
  return (
    prev.top === next.top &&
    prev.horizontal === next.horizontal &&
    prev.hidden === next.hidden &&
    prev.columnLeft === next.columnLeft &&
    prev.columnWidth === next.columnWidth &&
    prev.mainAxisGap === next.mainAxisGap &&
    prev.crossAxisGap === next.crossAxisGap &&
    prev.renderMode === next.renderMode &&
    prev.index === next.index &&
    prev.renderItem === next.renderItem &&
    prev.SeparatorComponent === next.SeparatorComponent &&
    prev.isLastItem === next.isLastItem &&
    prev.enqueueItemSize === next.enqueueItemSize &&
    prev.fixedSize === next.fixedSize &&
    prev.autoFixedSize === next.autoFixedSize &&
    prev.cellBridge === next.cellBridge &&
    areItemsEquivalent(prev.item, next.item, next.index, prev.itemsAreEqual, next.itemsAreEqual)
  );
}

export const MEASUREMENT_NOISE_EPSILON_DP = 1 / PixelRatio.get() + 0.01;
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

export interface NitroListCellContentProps {
  index: number;
  item: unknown;
  renderItem: NitroListRenderItem<unknown>;
  SeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  isLastItem: boolean;
  renderMode: NitroListRenderMode;
  itemsAreEqual?: ItemsAreEqualFn;
}

export function areCellContentPropsEqual(
  prev: NitroListCellContentProps,
  next: NitroListCellContentProps,
): boolean {
  return (
    prev.index === next.index &&
    prev.renderItem === next.renderItem &&
    prev.SeparatorComponent === next.SeparatorComponent &&
    prev.isLastItem === next.isLastItem &&
    prev.renderMode === next.renderMode &&
    areItemsEquivalent(prev.item, next.item, next.index, prev.itemsAreEqual, next.itemsAreEqual)
  );
}

export const NitroListCellContent = React.memo(function NitroListCellContent({
  index,
  item,
  renderItem,
  SeparatorComponent,
  isLastItem,
  renderMode,
}: NitroListCellContentProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemContentRender();
  }
  return (
    <>
      {renderItem({item, index, target: 'Cell', renderMode})}
      {SeparatorComponent != null && !isLastItem ? <SeparatorComponent leadingItem={item} /> : null}
    </>
  );
}, areCellContentPropsEqual);

export const NitroListItemContainer = React.memo(function NitroListItemContainer({
  index,
  top,
  horizontal,
  hidden,
  columnLeft,
  columnWidth,
  mainAxisGap,
  crossAxisGap,
  renderMode,
  item,
  renderItem,
  SeparatorComponent,
  isLastItem,
  enqueueItemSize,
  fixedSize,
  autoFixedSize,
  cellBridge,
  itemsAreEqual,
}: NitroListItemContainerProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemRender();
  }
  useEffect(() => {
    if (!NITRO_LIST_PERF_COMPILED) return;
    NitroListPerfMonitor.recordItemMount();
    return () => {
      NitroListPerfMonitor.recordItemUnmount();
    };
  }, []);
  const effectiveFixedSize = fixedSize ?? autoFixedSize;
  const layoutTrackRef = useRef({registered: false, laidOut: false});
  useEffect(() => {
    if (effectiveFixedSize != null) return;
    const track = layoutTrackRef.current;
    if (track.laidOut) return;
    track.registered = true;
    cellBridge.awaitingLayout++;
    return () => {
      if (track.registered && !track.laidOut) {
        track.registered = false;
        cellBridge.awaitingLayout--;
        if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
      }
    };
  }, []);
  const lastReportedRef = useRef<number>(-1);
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const track = layoutTrackRef.current;
      if (!track.laidOut) {
        track.laidOut = true;
        if (track.registered) {
          track.registered = false;
          cellBridge.awaitingLayout--;
        }
      }
      const layout = e.nativeEvent.layout;
      const size = (horizontal ? layout.width : layout.height) + mainAxisGap;
      if (
        lastReportedRef.current >= 0 &&
        Math.abs(size - lastReportedRef.current) <= MEASUREMENT_NOISE_EPSILON_DP
      ) {
        if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
        return;
      }
      lastReportedRef.current = size;
      enqueueItemSize(index, size);
      if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
    },
    [index, horizontal, mainAxisGap, enqueueItemSize, cellBridge],
  );
  const verifyAutoFixedLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const layout = e.nativeEvent.layout;
      const size = (horizontal ? layout.width : layout.height) + mainAxisGap;
      if (autoFixedSize != null && Math.abs(size - autoFixedSize) > MEASUREMENT_NOISE_EPSILON_DP) {
        cellBridge.onAutoFixedMismatch(index, size);
      }
    },
    [autoFixedSize, index, horizontal, mainAxisGap, cellBridge],
  );
  const verifyFixedSizeLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const layout = e.nativeEvent.layout;
      const height = horizontal ? layout.width : layout.height;
      if (fixedSize != null && Math.abs(height - fixedSize) > MEASUREMENT_NOISE_EPSILON_DP) {
        warnDevOnce(
          'fixed-item-size-mismatch',
          `getFixedItemSize returned ${fixedSize} for index ${index}, but the cell measured ` +
            `${height}. Fixed-size cells skip measurement, so the fixed value wins and items ` +
            `after this one will overlap or gap. Fix getFixedItemSize or remove it for this item.`,
        );
      }
    },
    [fixedSize, index, horizontal],
  );
  const containerStyle = useMemo(() => {
    const visibility = hidden ? styles.hiddenCell : null;
    if (columnLeft != null && columnWidth != null) {
      return [
        styles.absoluteCell,
        {
          top,
          left: columnLeft as unknown as number,
          width: columnWidth as unknown as number,
          paddingLeft: crossAxisGap / 2,
          paddingRight: crossAxisGap / 2,
        },
        visibility,
      ];
    }
    return horizontal
      ? [styles.absoluteColumn, {left: top}, visibility]
      : [styles.absoluteRow, {top}, visibility];
  }, [horizontal, top, columnLeft, columnWidth, crossAxisGap, hidden]);
  return (
    <View
      collapsable={false}
      pointerEvents={hidden ? 'none' : undefined}
      onLayout={
        effectiveFixedSize == null
          ? handleLayout
          : fixedSize != null
            ? IS_DEV
              ? verifyFixedSizeLayout
              : undefined
            : verifyAutoFixedLayout
      }
      style={containerStyle}>
      <NitroListCellContent
        index={index}
        item={item}
        renderItem={renderItem}
        SeparatorComponent={SeparatorComponent}
        isLastItem={isLastItem}
        renderMode={renderMode}
        itemsAreEqual={itemsAreEqual}
      />
    </View>
  );
}, areItemContainerPropsEqual);

export function MvcpAdjustAnchorSlot({store, horizontal}: {store: ListStore; horizontal: boolean}) {
  const mvcpAdjust = useStoreValue(store, 'mvcpAdjust');
  return <MvcpAdjustAnchor top={MVCP_ANCHOR_BASE + mvcpAdjust} horizontal={horizontal} />;
}

export const MvcpAdjustAnchor = React.memo(function MvcpAdjustAnchor({
  top,
  horizontal,
}: {
  top: number;
  horizontal: boolean;
}) {
  const style = useMemo(
    () =>
      horizontal
        ? [styles.mvcpAnchorHorizontal, {left: top}]
        : [styles.mvcpAnchor, {top}],
    [horizontal, top],
  );
  return <View collapsable={false} style={style} />;
});

export interface StickyOverlayProps {
  translateY: SharedValue<number>;
  horizontal: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  children: React.ReactNode;
}

export const StickyOverlay = React.memo(function StickyOverlay({
  translateY,
  horizontal,
  onLayout,
  children,
}: StickyOverlayProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: horizontal
      ? [{translateX: translateY.value}]
      : [{translateY: translateY.value}],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      collapsable={false}
      onLayout={onLayout}
      style={[horizontal ? styles.stickyOverlayHorizontal : styles.stickyOverlay, animatedStyle]}>
      {children}
    </Animated.View>
  );
});

export const styles = StyleSheet.create({
  hiddenCell: {
    opacity: 0,
  },
  stickyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  absoluteRow: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  absoluteColumn: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  absoluteCell: {
    position: 'absolute',
  },
  stickyOverlayHorizontal: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  mvcpAnchor: {
    position: 'absolute',
    left: 0,
    width: 1,
    height: 1,
  },
  mvcpAnchorHorizontal: {
    position: 'absolute',
    top: 0,
    width: 1,
    height: 1,
  },
});

