import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useInsertionEffect,
} from 'react';
import {PixelRatio, StyleSheet, View, type LayoutChangeEvent} from 'react-native';

import {checkDuplicateKeyDev, warnDevOnce} from './devWarnings';
import {ListStore, useStoreValue, type RangeState} from './listStore';
import {MVCP_ANCHOR_BASE} from './mvcp';
import type {MeasurementIdentity, MeasurementRevision} from './measurementIdentity';
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
  cells: Set<CellRecord>;
  onLayoutSettled: () => void;
  onAutoFixedMismatch: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void;
};

export type CellRecord = {
  identity: MeasurementIdentity | null;
  raw: number;
  reported: number;
  horizontal: boolean;
  gap: number;
  measures: boolean;
  fixedSize: number | undefined;
  autoFixedSize: number | undefined;
  rearm: boolean;
  awaiting: boolean;
  laidOut: boolean;
};

export function createCellRecord(): CellRecord {
  return {
    identity: null,
    raw: -1,
    reported: -1,
    horizontal: false,
    gap: 0,
    measures: false,
    fixedSize: undefined,
    autoFixedSize: undefined,
    rearm: false,
    awaiting: false,
    laidOut: false,
  };
}

export function resupplyCellSize(
  record: CellRecord,
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void,
): void {
  const identity = record.identity;
  if (identity == null || record.raw < 0) return;
  const size = record.raw + record.gap;
  record.laidOut = true;
  record.reported = size;
  enqueueItemSize(identity.index, size, identity);
}

function registerCell(cellBridge: CellBridge, record: CellRecord): () => void {
  cellBridge.cells.add(record);
  return () => {
    cellBridge.cells.delete(record);
    if (record.awaiting) {
      record.awaiting = false;
      cellBridge.awaitingLayout--;
      if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
    }
  };
}

function deactivateOnCleanup(identity: MeasurementIdentity): () => void {
  return () => {
    identity.active = false;
  };
}

function recordItemLifetime(): (() => void) | undefined {
  if (!NITRO_LIST_PERF_COMPILED) return undefined;
  NitroListPerfMonitor.recordItemMount();
  return recordItemUnmount;
}

function recordItemUnmount(): void {
  NitroListPerfMonitor.recordItemUnmount();
}

function createCellLayoutHandler(
  record: CellRecord,
  cellBridge: CellBridge,
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void,
): (e: LayoutChangeEvent) => void {
  return (e) => {
    const layout = e.nativeEvent.layout;
    const raw = record.horizontal ? layout.width : layout.height;
    record.raw = raw;
    const current = record.identity;
    if (current == null || !current.active) return;
    if (record.fixedSize != null) {
      if (IS_DEV && Math.abs(raw - record.fixedSize) > MEASUREMENT_NOISE_EPSILON_DP) {
        warnDevOnce(
          'fixed-item-size-mismatch',
          `getFixedItemSize returned ${record.fixedSize} for index ${current.index}, but the ` +
            `cell measured ${raw}. Fixed-size cells skip measurement, so the fixed value wins ` +
            `and items after this one will overlap or gap. Fix getFixedItemSize or remove it ` +
            `for this item.`,
        );
      }
      return;
    }
    if (current.geometry !== current.revision.geometry) return;
    const size = raw + record.gap;
    if (record.autoFixedSize != null) {
      if (Math.abs(size - record.autoFixedSize) > MEASUREMENT_NOISE_EPSILON_DP) {
        cellBridge.onAutoFixedMismatch(current.index, size, current);
      }
      return;
    }
    if (!record.laidOut) {
      record.laidOut = true;
      if (record.awaiting) {
        record.awaiting = false;
        cellBridge.awaitingLayout--;
      }
    }
    if (
      record.reported >= 0 &&
      Math.abs(size - record.reported) <= MEASUREMENT_NOISE_EPSILON_DP
    ) {
      if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
      return;
    }
    record.reported = size;
    enqueueItemSize(current.index, size, current);
    if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
  };
}

export function markCellSupplied(record: CellRecord, cellBridge: CellBridge): void {
  record.laidOut = true;
  record.reported = record.raw + record.gap;
  if (!record.awaiting) return;
  record.awaiting = false;
  cellBridge.awaitingLayout--;
  if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
}

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
  measurementRevision: MeasurementRevision;
  measurementGeometry: number;
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  keyExtractor?: (item: unknown, index: number) => string;
  getItemType?: (item: unknown, index: number) => ItemTypeKey;
  getFixedItemSize?: (
    item: unknown,
    index: number,
    type: ItemTypeKey | undefined,
  ) => number | undefined;
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
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void;
  cellBridge: CellBridge;
  itemsAreEqual?: ItemsAreEqualFn;
  readItemOffset: (index: number) => number;
  ensureLayout: (start: number, end?: number) => void;
  onCommit: (
    range: RangeState,
    prewarmRange: RangeState | null,
    phase: 'layout' | 'passive',
  ) => void;
}

const CALLBACK_PROPS_READ_ON_RENDER = new Set<keyof NitroListCellsProps>([
  'keyExtractor',
  'getItemType',
  'getFixedItemSize',
  'itemsAreEqual',
]);

export function areCellsPropsEqual(prev: NitroListCellsProps, next: NitroListCellsProps): boolean {
  for (const key of Object.keys(next) as Array<keyof NitroListCellsProps>) {
    if (CALLBACK_PROPS_READ_ON_RENDER.has(key)) {
      if ((prev[key] == null) !== (next[key] == null)) return false;
    } else if (!Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return Object.keys(prev).length === Object.keys(next).length;
}

export const NitroListCells = React.memo(function NitroListCells({
  measurementRevision,
  measurementGeometry,
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
  ensureLayout,
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

  const effectiveRenderMode: NitroListRenderMode = adaptiveRenderMode ? renderMode : 'normal';
  type CellMetadata = {
    item: unknown;
    revision: MeasurementRevision;
    geometry: number;
    itemKey: string;
    itemType: ItemTypeKey | undefined;
    reactKey: string;
    explicitFixedSize: number | undefined;
  };
  const metadataRef = useRef(new Map<number, CellMetadata>());
  const nextMetadata = new Map<number, CellMetadata>();
  useInsertionEffect(() => {
    metadataRef.current = nextMetadata;
  });
  const seenRenderKeys = IS_DEV ? new Set<string>() : null;
  for (const {start, end} of mergeRenderRanges(renderRanges)) {
    ensureLayout(start, end);
    for (let i = start; i <= end; i++) {
      const item = items[i];
      let metadata = metadataRef.current.get(i);
      if (
        metadata == null ||
        metadata.item !== item ||
        metadata.revision !== measurementRevision ||
        metadata.geometry !== measurementGeometry
      ) {
        const itemKey = keyExtractor ? keyExtractor(item, i) : String(i);
        const itemType = getItemType?.(item, i);
        const explicitFixedSize = getFixedItemSize?.(item, i, itemType);
        metadata = {
          item,
          revision: measurementRevision,
          geometry: measurementGeometry,
          itemKey,
          itemType,
          explicitFixedSize,
          reactKey: JSON.stringify([typeof itemType, itemType, itemKey]),
        };
        if (NITRO_LIST_PERF_COMPILED)
          NitroListPerfMonitor.recordUserCallbacks(
            Number(keyExtractor != null) +
              Number(getItemType != null) +
              Number(getFixedItemSize != null),
          );
      }
      // Retain only metadata from this committed window, with a fixed cap for alwaysRender.
      if (nextMetadata.size < 512) nextMetadata.set(i, metadata);
      const {itemKey, itemType, explicitFixedSize, reactKey} = metadata;
      if (seenRenderKeys != null) checkDuplicateKeyDev(seenRenderKeys, itemKey);
      const autoFixedSize =
        explicitFixedSize == null && autoFixedTypes != null && itemType !== undefined
          ? autoFixedTypes.get(itemType)
          : undefined;
      const top = readItemOffset(i);
      renderedChildren.push(
        <NitroListItemContainer
          key={reactKey}
          measurementRevision={measurementRevision}
          measurementGeometry={measurementGeometry}
          index={i}
          top={top}
          horizontal={horizontal}
          hidden={hideRelatedCell && i === stickyIndex}
          columnLeft={
            columnLayout != null ? `${(columnLayout.colOf[i] / resolvedColumns) * 100}%` : undefined
          }
          columnWidth={
            columnLayout != null ? `${(columnLayout.spans[i] / resolvedColumns) * 100}%` : undefined
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
          itemsAreEqual={
            itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined
          }
        />,
      );
    }
  }

  return <>{renderedChildren}</>;
}, areCellsPropsEqual);

export function ListContainer({
  store,
  horizontal,
  children,
}: {
  store: ListStore;
  horizontal: boolean;
  children: React.ReactNode;
}) {
  const containerSize = useStoreValue(store, 'containerSize');
  return (
    <View collapsable={false} style={horizontal ? {width: containerSize} : {height: containerSize}}>
      {children}
    </View>
  );
}

export function EndSpaceSpacer({store, horizontal}: {store: ListStore; horizontal: boolean}) {
  const endSpace = useStoreValue(store, 'endSpace');
  if (endSpace <= 0) return null;
  return <View style={horizontal ? {width: endSpace} : {height: endSpace}} />;
}

export interface NitroListItemContainerProps {
  measurementRevision: MeasurementRevision;
  measurementGeometry: number;
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
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void;
  fixedSize?: number;
  autoFixedSize?: number;
  cellBridge: CellBridge;
  itemsAreEqual?: ItemsAreEqualFn;
}

export function areItemsEquivalent(
  prevItem: unknown,
  nextItem: unknown,
  index: number,
  itemsAreEqual: ItemsAreEqualFn | undefined,
): boolean {
  if (prevItem === nextItem) return true;
  return itemsAreEqual != null && itemsAreEqual(prevItem, nextItem, index);
}

export function areItemContainerPropsEqual(
  prev: NitroListItemContainerProps,
  next: NitroListItemContainerProps,
): boolean {
  return (
    prev.measurementRevision === next.measurementRevision &&
    prev.measurementGeometry === next.measurementGeometry &&
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
    areItemsEquivalent(prev.item, next.item, next.index, next.itemsAreEqual)
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
    areItemsEquivalent(prev.item, next.item, next.index, next.itemsAreEqual)
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
  measurementRevision,
  measurementGeometry,
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
  useEffect(recordItemLifetime, []);
  const recordRef = useRef<CellRecord | null>(null);
  if (recordRef.current == null) recordRef.current = createCellRecord();
  const record = recordRef.current;
  const measures = fixedSize == null && autoFixedSize == null;
  const identity = useMemo<MeasurementIdentity>(
    () => ({
      index,
      item,
      revision: measurementRevision,
      geometry: measurementGeometry,
      active: false,
    }),
    [index, item, measurementRevision, measurementGeometry],
  );
  useLayoutEffect(() => registerCell(cellBridge, record), [cellBridge, record]);
  useLayoutEffect(() => {
    const previous = record.identity;
    const wasMeasuring = record.measures;
    identity.active = true;
    record.identity = identity;
    record.horizontal = horizontal;
    record.gap = mainAxisGap;
    record.measures = measures;
    record.fixedSize = fixedSize;
    record.autoFixedSize = autoFixedSize;
    if (previous !== identity) {
      record.laidOut = record.raw >= 0;
      record.reported = record.raw >= 0 ? record.raw + record.gap : -1;
    }
    if (measures && record.raw >= 0) {
      const invalidated =
        record.rearm ||
        (previous != null &&
          (previous.revision !== identity.revision || previous.geometry !== identity.geometry));
      record.rearm = false;
      if (invalidated) {
        resupplyCellSize(record, enqueueItemSize);
      } else if (!wasMeasuring && previous === identity) {
        record.laidOut = true;
        record.reported = record.raw + record.gap;
      }
    }
    const waits = measures && !record.laidOut;
    if (waits !== record.awaiting) {
      record.awaiting = waits;
      if (waits) {
        cellBridge.awaitingLayout++;
      } else {
        cellBridge.awaitingLayout--;
        if (cellBridge.awaitingLayout === 0) cellBridge.onLayoutSettled();
      }
    }
    return deactivateOnCleanup(identity);
  }, [
    identity,
    horizontal,
    mainAxisGap,
    measures,
    fixedSize,
    autoFixedSize,
    cellBridge,
    enqueueItemSize,
    record,
  ]);
  const handleLayout = useMemo(
    () => createCellLayoutHandler(record, cellBridge, enqueueItemSize),
    [record, cellBridge, enqueueItemSize],
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
    <View pointerEvents={hidden ? 'none' : undefined} style={containerStyle}>
      <View
        onLayout={fixedSize != null && !IS_DEV ? undefined : handleLayout}
        style={styles.cellMeasure}
      >
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
    () => (horizontal ? [styles.mvcpAnchorHorizontal, {left: top}] : [styles.mvcpAnchor, {top}]),
    [horizontal, top],
  );
  return <View collapsable={false} style={style} />;
});

export const styles = StyleSheet.create({
  hiddenCell: {
    opacity: 0,
  },
  cellMeasure: {
    flexGrow: 1,
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
