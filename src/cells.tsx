import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useInsertionEffect,
} from 'react';
import {PixelRatio, StyleSheet, View, type LayoutChangeEvent} from 'react-native';

import {checkDuplicateKeyDev, warnDevOnce} from './devWarnings';
import {ListStore, useStoreValue, useStoreValues, type RangeState} from './listStore';
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
  followIndex: number;
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
  occupant: string | undefined;
  host: View | null;
  attachHost: (view: View | null) => void;
};

export function createCellRecord(): CellRecord {
  const record: CellRecord = {
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
    occupant: undefined,
    host: null,
    attachHost: () => {},
  };
  record.attachHost = (view) => {
    record.host = view;
  };
  return record;
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

type MeasurableHost = {
  measureLayout?: (
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ) => void;
};

export function measureHostSize(view: View | null, horizontal: boolean): number | null {
  const host = view as unknown as MeasurableHost | null;
  if (host == null || typeof host.measureLayout !== 'function') return null;
  let size: number | null = null;
  host.measureLayout(host, (_x, _y, width, height) => {
    size = horizontal ? width : height;
  });
  return size;
}

function createCellLayoutHandler(
  record: CellRecord,
  cellBridge: CellBridge,
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void,
): (e: LayoutChangeEvent) => void {
  return (e) => {
    const layout = e.nativeEvent.layout;
    applyCellSize(record, cellBridge, enqueueItemSize, record.horizontal ? layout.width : layout.height);
  };
}

function applyCellSize(
  record: CellRecord,
  cellBridge: CellBridge,
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void,
  raw: number,
): void {
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

type CellPool = {
  slots: Map<string, number>;
  types: Map<number, string>;
  elements: Map<number, React.ReactElement>;
  lastKeys: Map<number, string>;
  next: number;
};

const MAX_PARKED_CELLS = 32;
const CELLS_STORE_KEYS = [
  'range',
  'prewarmRange',
  'dataItems',
  'stickyIndex',
  'autoFixedTypes',
  'renderMode',
] as const;

function emptyCellPool(): CellPool {
  return {slots: new Map(), types: new Map(), elements: new Map(), lastKeys: new Map(), next: 0};
}

function assignCellSlots(
  previous: CellPool,
  entries: ReadonlyArray<CellEntry>,
): {pool: CellPool; slots: number[]; parked: number[]} {
  const pool: CellPool = {
    slots: new Map(),
    types: new Map(),
    elements: new Map(),
    lastKeys: new Map(previous.lastKeys),
    next: previous.next,
  };
  const taken = new Uint8Array(previous.next);
  const slots = new Array<number>(entries.length);
  const pending: number[] = [];
  for (let position = 0; position < entries.length; position++) {
    const {reactKey, typeKey} = entries[position].metadata;
    const kept = previous.slots.get(reactKey);
    if (kept == null) {
      pending.push(position);
      continue;
    }
    taken[kept] = 1;
    slots[position] = kept;
    pool.slots.set(reactKey, kept);
    pool.types.set(kept, typeKey);
  }
  const free = new Map<string, number[]>();
  for (const slot of previous.slots.values()) {
    if (taken[slot] === 1) continue;
    const typeKey = previous.types.get(slot)!;
    const list = free.get(typeKey);
    if (list == null) free.set(typeKey, [slot]);
    else list.push(slot);
  }
  if (pending.length > 0) {
    const freeByLastKey = new Map<string, number>();
    for (const list of free.values()) {
      for (const slot of list) {
        const lastKey = previous.lastKeys.get(slot);
        if (lastKey != null) freeByLastKey.set(lastKey, slot);
      }
    }
    for (const position of pending) {
      const {reactKey, typeKey} = entries[position].metadata;
      const list = free.get(typeKey);
      const own = freeByLastKey.get(reactKey);
      const ownAt = own != null && list != null ? list.indexOf(own) : -1;
      let reused: number | undefined;
      if (ownAt >= 0) {
        list!.splice(ownAt, 1);
        reused = own;
      } else {
        reused = list?.pop();
      }
      const slot = reused ?? pool.next++;
      slots[position] = slot;
      pool.slots.set(reactKey, slot);
      pool.types.set(slot, typeKey);
    }
  }
  for (let position = 0; position < entries.length; position++) {
    pool.lastKeys.set(slots[position], entries[position].metadata.reactKey);
  }
  const parked: number[] = [];
  for (const list of free.values()) {
    for (const slot of list) {
      if (parked.length >= MAX_PARKED_CELLS || !previous.elements.has(slot)) continue;
      parked.push(slot);
      pool.types.set(slot, previous.types.get(slot)!);
      pool.slots.set(`parked-${slot}`, slot);
    }
  }
  return {pool, slots, parked};
}

function rangeKeysMoved(
  rendered: ReadonlyMap<number, {item: unknown; itemKey: string}>,
  items: ReadonlyArray<unknown>,
  range: RangeState,
  keyExtractor: (item: unknown, index: number) => string,
): boolean {
  for (const index of [range.start, range.end]) {
    const previous = rendered.get(index);
    if (previous == null) continue;
    const item = items[index];
    if (item === previous.item) continue;
    if (item === undefined || keyExtractor(item, index) !== previous.itemKey) return true;
  }
  return false;
}

type CellEntry = {
  index: number;
  item: unknown;
  metadata: {reactKey: string; typeKey: string; itemType: ItemTypeKey | undefined; explicitFixedSize: number | undefined};
  top: number;
};

type CellSharedProps = Pick<
  NitroListItemContainerProps,
  | 'recycled'
  | 'measurementRevision'
  | 'measurementGeometry'
  | 'horizontal'
  | 'mainAxisGap'
  | 'crossAxisGap'
  | 'renderMode'
  | 'renderItem'
  | 'SeparatorComponent'
  | 'enqueueItemSize'
  | 'cellBridge'
  | 'itemsAreEqual'
>;

type CellElementCache = {
  shared: CellSharedProps | null;
  elements: Map<string, React.ReactElement<NitroListItemContainerProps>>;
};

function sameCellSharedProps(a: CellSharedProps | null, b: CellSharedProps): boolean {
  if (a == null) return false;
  for (const key in b) {
    if (a[key as keyof CellSharedProps] !== b[key as keyof CellSharedProps]) return false;
  }
  return true;
}

type CellBuildContext = {
  shared: CellSharedProps;
  previous: Map<string, React.ReactElement<NitroListItemContainerProps>> | null;
  next: Map<string, React.ReactElement<NitroListItemContainerProps>>;
  autoFixedTypes: ReadonlyMap<ItemTypeKey, number> | null;
  hiddenIndex: number;
  lastIndex: number;
  columnLayout: {colOf: ArrayLike<number>; spans: ArrayLike<number>} | null | undefined;
  resolvedColumns: number;
  recycleItems: boolean;
};

function buildCellElement(
  entry: CellEntry,
  key: string,
  build: CellBuildContext,
): React.ReactElement<NitroListItemContainerProps> {
  const {index: i, item, metadata, top} = entry;
  const {itemType, explicitFixedSize, reactKey} = metadata;
  const autoFixedSize =
    explicitFixedSize == null && build.autoFixedTypes != null && itemType !== undefined
      ? build.autoFixedTypes.get(itemType)
      : undefined;
  const hidden = i === build.hiddenIndex;
  const isLastItem = i === build.lastIndex;
  const columnLeft =
    build.columnLayout != null ? `${(build.columnLayout.colOf[i] / build.resolvedColumns) * 100}%` : undefined;
  const columnWidth =
    build.columnLayout != null ? `${(build.columnLayout.spans[i] / build.resolvedColumns) * 100}%` : undefined;
  const occupant = build.recycleItems ? reactKey : undefined;
  const previous = build.previous?.get(key);
  if (previous != null) {
    const props = previous.props;
    if (
      props.item === item &&
      props.index === i &&
      props.top === top &&
      props.hidden === hidden &&
      props.isLastItem === isLastItem &&
      props.fixedSize === explicitFixedSize &&
      props.autoFixedSize === autoFixedSize &&
      props.occupant === occupant &&
      props.parked !== true &&
      props.columnLeft === columnLeft &&
      props.columnWidth === columnWidth
    ) {
      build.next.set(key, previous);
      return previous;
    }
  }
  const element = (
    <NitroListItemContainer
      key={key}
      {...build.shared}
      occupant={occupant}
      index={i}
      top={top}
      hidden={hidden}
      columnLeft={columnLeft}
      columnWidth={columnWidth}
      item={item}
      isLastItem={isLastItem}
      fixedSize={explicitFixedSize}
      autoFixedSize={autoFixedSize}
    />
  ) as React.ReactElement<NitroListItemContainerProps>;
  build.next.set(key, element);
  return element;
}

export interface NitroListCellsProps {
  firstPaintLimit: number;
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
  recycleItems: boolean;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  enqueueItemSize: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void;
  cellBridge: CellBridge;
  itemsAreEqual?: ItemsAreEqualFn;
  readItemOffset: (index: number) => number;
  ensureLayout: (start: number, end?: number) => void;
  onCommit: (
    range: RangeState,
    prewarmRange: RangeState | null,
    phase: 'measure' | 'layout' | 'passive',
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
  firstPaintLimit,
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
  recycleItems,
  ItemSeparatorComponent,
  enqueueItemSize,
  cellBridge,
  itemsAreEqual,
  readItemOffset,
  ensureLayout,
  onCommit,
}: NitroListCellsProps) {
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordCellsRender();
  const {range, prewarmRange, dataItems, stickyIndex, autoFixedTypes, renderMode} = useStoreValues(
    store,
    CELLS_STORE_KEYS,
  );
  const heldOutputRef = useRef<React.ReactElement | null>(null);
  useLayoutEffect(() => {
    onCommit(range, prewarmRange, 'measure');
  });
  useLayoutEffect(() => {
    onCommit(range, prewarmRange, 'layout');
  }, [range, prewarmRange, onCommit]);
  useEffect(() => {
    onCommit(range, prewarmRange, 'passive');
  }, [range, prewarmRange, onCommit]);

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
    typeKey: string;
    explicitFixedSize: number | undefined;
  };
  const metadataRef = useRef(new Map<number, CellMetadata>());
  const nextMetadata = new Map<number, CellMetadata>();
  const poolRef = useRef<CellPool>(emptyCellPool());
  const elementCacheRef = useRef<CellElementCache>({shared: null, elements: new Map()});
  const shared: CellSharedProps = {
    recycled: recycleItems,
    measurementRevision,
    measurementGeometry,
    horizontal,
    mainAxisGap,
    crossAxisGap,
    renderMode: effectiveRenderMode,
    renderItem: renderItem as NitroListRenderItem<unknown>,
    SeparatorComponent: ItemSeparatorComponent as React.ComponentType<{leadingItem: unknown}> | undefined,
    enqueueItemSize,
    cellBridge,
    itemsAreEqual: itemsAreEqual as ItemsAreEqualFn | undefined,
  };
  const nextElements = new Map<string, React.ReactElement<NitroListItemContainerProps>>();
  let nextPool: CellPool | null = null;
  const holding =
    dataItems != null &&
    dataItems !== items &&
    heldOutputRef.current != null &&
    keyExtractor != null &&
    rangeKeysMoved(metadataRef.current, items, range, keyExtractor);
  let renderedOutput: React.ReactElement | null = null;
  useInsertionEffect(() => {
    if (holding) return;
    metadataRef.current = nextMetadata;
    if (nextPool != null) poolRef.current = nextPool;
    elementCacheRef.current = {shared, elements: nextElements};
    heldOutputRef.current = renderedOutput;
  });
  if (holding) return heldOutputRef.current;
  const previousElements = sameCellSharedProps(elementCacheRef.current.shared, shared)
    ? elementCacheRef.current.elements
    : null;
  const seenRenderKeys = IS_DEV ? new Set<string>() : null;
  const entries: CellEntry[] = [];
  let firstTop = Number.POSITIVE_INFINITY;
  let lastTop = Number.NEGATIVE_INFINITY;
  for (const {start, end: rangeEnd} of mergeRenderRanges(renderRanges)) {
    const end = firstPaintLimit > 0 ? Math.min(rangeEnd, start + firstPaintLimit - 1) : rangeEnd;
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
        const typeKey = `${typeof itemType}:${itemType}`;
        metadata = {
          item,
          revision: measurementRevision,
          geometry: measurementGeometry,
          itemKey,
          itemType,
          explicitFixedSize,
          reactKey: `${typeKey.length}:${typeKey}${itemKey}`,
          typeKey,
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
      if (seenRenderKeys != null) checkDuplicateKeyDev(seenRenderKeys, metadata.itemKey);
      const top = readItemOffset(i);
      if (top < firstTop) firstTop = top;
      if (top > lastTop) lastTop = top;
      entries.push({index: i, item, metadata, top});
    }
  }

  const build: CellBuildContext = {
    shared,
    previous: previousElements,
    next: nextElements,
    autoFixedTypes,
    hiddenIndex: hideRelatedCell ? stickyIndex : -1,
    lastIndex: itemCount - 1,
    columnLayout,
    resolvedColumns,
    recycleItems,
  };
  if (recycleItems) {
    const assigned = assignCellSlots(poolRef.current, entries);
    nextPool = assigned.pool;
    const bySlot = new Array<React.ReactElement | undefined>(nextPool.next);
    for (let position = 0; position < entries.length; position++) {
      const slot = assigned.slots[position];
      const element = buildCellElement(entries[position], `slot-${slot}`, build);
      nextPool.elements.set(slot, element);
      bySlot[slot] = element;
    }
    for (const slot of assigned.parked) {
      const element = poolRef.current.elements.get(slot)! as React.ReactElement<NitroListItemContainerProps>;
      if (
        element.props.item !== items[element.props.index] ||
        element.props.measurementRevision !== measurementRevision
      ) {
        nextPool.slots.delete(`parked-${slot}`);
        nextPool.types.delete(slot);
        continue;
      }
      const near = element.props.top >= firstTop && element.props.top <= lastTop;
      const parkedElement = element.props.parked && (!near || element.props.hidden)
        ? element
        : React.cloneElement(element, near ? {parked: true, hidden: true} : {parked: true});
      nextPool.elements.set(slot, parkedElement);
      bySlot[slot] = parkedElement;
    }
    const children: React.ReactElement[] = [];
    for (let slot = 0; slot < bySlot.length; slot++) {
      const element = bySlot[slot];
      if (element !== undefined) children.push(element);
    }
    build.previous = null;
    renderedOutput = <>{children}</>;
    return renderedOutput;
  }
  const renderedChildren = new Array<React.ReactElement>(entries.length);
  for (let k = 0; k < entries.length; k++) {
    renderedChildren[k] = buildCellElement(entries[k], entries[k].metadata.reactKey, build);
  }
  build.previous = null;
  renderedOutput = <>{renderedChildren}</>;
  return renderedOutput;
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
  recycled: boolean;
  parked?: boolean;
  occupant?: string;
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
    prev.recycled === next.recycled &&
    prev.parked === next.parked &&
    prev.occupant === next.occupant &&
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
  recycled,
  occupant,
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
    const reused = recycled && record.occupant !== undefined && record.occupant !== occupant;
    record.occupant = occupant;
    if (reused) {
      record.raw = -1;
      record.reported = -1;
      record.laidOut = false;
    }
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
    if (
      measures &&
      (reused || previous !== identity || !record.laidOut) &&
      identity.geometry === identity.revision.geometry
    ) {
      const raw = measureHostSize(record.host, horizontal);
      if (raw != null && raw >= 0) applyCellSize(record, cellBridge, enqueueItemSize, raw);
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
    recycled,
    occupant,
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
        ref={record.attachHost}
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
