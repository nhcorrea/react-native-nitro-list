import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useInsertionEffect,
} from 'react';
import {findNodeHandle, PixelRatio, Platform, StyleSheet, TextInput, View, type LayoutChangeEvent} from 'react-native';

import {NitroListDevFlags} from './devFlags';
import {markPlan3Publication} from './transitionDiagnostics';
import {checkDuplicateKeyDev, countNewKeysDev, maybeWarnRecycleItemsUnset, warnDevOnce} from './devWarnings';
import {ListStore, useStoreValue, useStoreValues, type RangeState} from './listStore';
import {MVCP_ANCHOR_BASES} from './mvcp';
import type {MeasurementIdentity, MeasurementRevision} from './measurementIdentity';
import {setNativeClipChildren} from './nativeScroll';
import {SlotPublisher, type SlotPublisherHandle} from './slotPublication';
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
  freeCells: number;
  createdCells: number;
  recycleItemsUnset: boolean;
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

type ContainsHost = {contains?: (node: unknown) => boolean};

export function focusedCellIndex(
  cellBridge: CellBridge,
  items?: ReadonlyArray<unknown>,
  keyExtractor?: (item: unknown, index: number) => string,
): number {
  const focused = TextInput.State?.currentlyFocusedInput?.();
  if (focused == null) return -1;
  for (const record of cellBridge.cells) {
    const identity = record.identity;
    if (identity == null || !identity.active) continue;
    const host = record.host as unknown as ContainsHost | null;
    if (typeof host?.contains === 'function' && host.contains(focused)) {
      if (items == null || keyExtractor == null || items[identity.index] === identity.item) return identity.index;
      // During a data remap the mounted record still belongs to the previous
      // commit. Retain its key in the new data, rather than its stale index.
      const focusedKey = keyExtractor(identity.item, identity.index);
      if (identity.index < items.length && keyExtractor(items[identity.index], identity.index) === focusedKey) return identity.index;
      for (let index = 0; index < items.length; index++) {
        if (keyExtractor(items[index], index) === focusedKey) return index;
      }
      return -1;
    }
  }
  return -1;
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

export type CellPool = {
  slots: Map<string, number>;
  types: Map<number, string>;
  elements: Map<number, React.ReactElement>;
  lastKeys: Map<number, string>;
  order: number[];
  demand: Map<string, number>;
  next: number;
};

export const MAX_PARKED_CELLS = 32;
const PARKED_AWAY_OFFSET = -(2 ** 20);
const CELLS_STORE_KEYS = [
  'plan3WindowPaused',
  'range',
  'prewarmRange',
  'reserveRange',
  'dataItems',
  'stickyIndex',
  'autoFixedTypes',
  'renderMode',
] as const;
const SLOT_CELLS_STORE_KEYS = [...CELLS_STORE_KEYS, 'mountSeq'] as const;

export function emptyCellPool(): CellPool {
  return {
    slots: new Map(),
    types: new Map(),
    elements: new Map(),
    lastKeys: new Map(),
    order: [],
    demand: new Map(),
    next: 0,
  };
}

function selectParkedSlots(
  free: ReadonlyMap<string, number[]>,
  demand: ReadonlyMap<string, number>,
  canPark: (slot: number) => boolean,
): Set<number> {
  const limit = NitroListDevFlags.experimentalParkedLimit8 ? 8 : MAX_PARKED_CELLS;
  const parked = new Set<number>();
  const candidates: Array<{slots: number[]; quota: number; cursor: number}> = [];
  for (const [typeKey, list] of free) {
    const quota = Math.min(list.length, demand.get(typeKey) ?? 0);
    if (quota > 0) candidates.push({slots: list, quota, cursor: 0});
  }
  let progressed = true;
  while (parked.size < limit && progressed) {
    progressed = false;
    for (const candidate of candidates) {
      if (parked.size >= limit) break;
      while (candidate.quota > 0 && candidate.cursor < candidate.slots.length) {
        const slot = candidate.slots[candidate.cursor++];
        if (!canPark(slot)) continue;
        parked.add(slot);
        candidate.quota--;
        progressed = true;
        break;
      }
    }
  }
  return parked;
}

function takeFarthestFreeSlot(
  free: ReadonlyMap<string, number[]>,
  low: number,
  high: number,
  occupantIndex: ((slot: number) => number | undefined) | undefined,
  canReuse?: (slot: number) => boolean,
): number | undefined {
  let bestList: number[] | null = null;
  let bestAt = -1;
  let bestDistance = -1;
  for (const list of free.values()) {
    for (let at = 0; at < list.length; at++) {
      if (canReuse != null && !canReuse(list[at])) continue;
      const index = occupantIndex?.(list[at]);
      const distance =
        index == null ? Number.POSITIVE_INFINITY : index < low ? low - index : index > high ? index - high : 0;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestList = list;
        bestAt = at;
      }
    }
  }
  return bestList == null ? undefined : bestList.splice(bestAt, 1)[0];
}

export function assignCellSlots(
  previous: CellPool,
  entries: ReadonlyArray<CellEntry>,
  canPark: (slot: number) => boolean,
  occupantIndex?: (slot: number) => number | undefined,
  protectedIndex?: number,
): {pool: CellPool; slots: number[]; parked: number[]} {
  const focusedEntry = protectedIndex == null ? undefined : entries.find(entry => entry.index === protectedIndex);
  const focusedSlot = focusedEntry == null ? undefined : previous.slots.get(focusedEntry.metadata.reactKey);
  const focusPosition = focusedSlot == null ? -1 : previous.order.indexOf(focusedSlot);
  const beforeFocus = focusPosition < 0 ? null : new Set(previous.order.slice(0, focusPosition));
  const pool: CellPool = {
    slots: new Map(),
    types: new Map(),
    elements: new Map(),
    lastKeys: new Map(),
    order: [],
    demand: new Map(),
    next: previous.next,
  };
  const slots = new Array<number>(entries.length);
  const active = new Set<number>();
  const pending: number[] = [];
  const windowDemand = new Map<string, number>();
  for (let position = 0; position < entries.length; position++) {
    const {reactKey, typeKey} = entries[position].metadata;
    windowDemand.set(typeKey, (windowDemand.get(typeKey) ?? 0) + 1);
    const kept = previous.slots.get(reactKey);
    if (kept == null) {
      pending.push(position);
      continue;
    }
    active.add(kept);
    slots[position] = kept;
    pool.slots.set(reactKey, kept);
    pool.types.set(kept, typeKey);
  }
  const free = new Map<string, number[]>();
  for (const slot of previous.order) {
    if (active.has(slot)) continue;
    const typeKey = previous.types.get(slot)!;
    const list = free.get(typeKey);
    if (list == null) free.set(typeKey, [slot]);
    else list.push(slot);
  }
  const created: number[] = [];
  if (pending.length > 0) {
    const freeByLastKey = new Map<string, number>();
    for (const list of free.values()) {
      for (const slot of list) {
        const lastKey = previous.lastKeys.get(slot);
        if (lastKey != null) freeByLastKey.set(lastKey, slot);
      }
    }
    const unassigned: number[] = [];
    for (const position of pending) {
      const {reactKey, typeKey} = entries[position].metadata;
      const list = free.get(typeKey);
      const own = freeByLastKey.get(reactKey);
      const protect = beforeFocus != null && entries[position].index < protectedIndex!;
      const ownAt = own != null && list != null && (!protect || beforeFocus!.has(own)) ? list.indexOf(own) : -1;
      let reused: number | undefined;
      if (ownAt >= 0) {
        list!.splice(ownAt, 1);
        reused = own;
      } else if (protect && list != null) {
        for (let at = list.length - 1; at >= 0; at--) {
          if (beforeFocus!.has(list[at])) {
            reused = list.splice(at, 1)[0];
            break;
          }
        }
      } else {
        reused = list?.pop();
      }
      if (reused == null) {
        unassigned.push(position);
        continue;
      }
      active.add(reused);
      slots[position] = reused;
      pool.slots.set(reactKey, reused);
      pool.types.set(reused, typeKey);
    }
    if (unassigned.length > 0) {
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (const entry of entries) {
        if (entry.index < low) low = entry.index;
        if (entry.index > high) high = entry.index;
      }
      for (const position of unassigned) {
        const {reactKey, typeKey} = entries[position].metadata;
        const canReuse = beforeFocus != null && entries[position].index < protectedIndex!
          ? (slot: number) => beforeFocus.has(slot)
          : undefined;
        let slot = takeFarthestFreeSlot(free, low, high, occupantIndex, canReuse);
        if (slot == null) {
          slot = pool.next++;
          created.push(slot);
        }
        active.add(slot);
        slots[position] = slot;
        pool.slots.set(reactKey, slot);
        pool.types.set(slot, typeKey);
      }
    }
  }
  for (let position = 0; position < entries.length; position++) {
    pool.lastKeys.set(slots[position], entries[position].metadata.reactKey);
  }
  for (const [typeKey, count] of windowDemand) pool.demand.set(typeKey, count);
  for (const [typeKey, count] of previous.demand) {
    if (free.has(typeKey) && count > (pool.demand.get(typeKey) ?? 0)) pool.demand.set(typeKey, count);
  }
  const parkedSet = selectParkedSlots(free, pool.demand, canPark);
  const parked: number[] = [];
  for (const slot of previous.order) {
    if (active.has(slot)) {
      pool.order.push(slot);
    } else if (parkedSet.has(slot)) {
      pool.order.push(slot);
      parked.push(slot);
      pool.types.set(slot, previous.types.get(slot)!);
      const lastKey = previous.lastKeys.get(slot);
      if (lastKey != null) pool.lastKeys.set(slot, lastKey);
    }
  }
  for (const slot of created) pool.order.push(slot);
  for (const typeKey of pool.demand.keys()) {
    if (!windowDemand.has(typeKey) && !parkedHasType(parked, pool.types, typeKey)) {
      pool.demand.delete(typeKey);
    }
  }
  return {pool, slots, parked};
}

function parkedHasType(parked: ReadonlyArray<number>, types: ReadonlyMap<number, string>, typeKey: string): boolean {
  for (const slot of parked) if (types.get(slot) === typeKey) return true;
  return false;
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

export const CELL_ORIGIN_SEGMENT = 65536;

export function nextCellOrigin(previous: number, anchorTop: number): number {
  if (anchorTop >= previous && anchorTop < previous + 2 * CELL_ORIGIN_SEGMENT) return previous;
  return anchorTop < CELL_ORIGIN_SEGMENT ? 0 : Math.floor(anchorTop / CELL_ORIGIN_SEGMENT) * CELL_ORIGIN_SEGMENT;
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
  | 'flow'
  | 'dataVersion'
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
  origin: number;
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
      (build.shared.flow === true || props.top === top) &&
      props.origin === build.origin &&
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
      origin={build.origin}
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
  dataVersion?: unknown;
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
  clipItems: boolean;
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
  onMountMarker?: (view: View | null) => void;
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

interface OriginClip {
  attach: (view: View | null) => void;
  setEnabled: (enabled: boolean) => void;
}

function createOriginClip(): OriginClip {
  let tag: number | null = null;
  let applied = false;
  let enabled = false;
  const sync = () => {
    if (tag == null || applied === enabled) return;
    setNativeClipChildren(tag, enabled);
    applied = enabled;
  };
  return {
    attach(view) {
      const next = view == null ? null : findNodeHandle(view);
      if (next == null) return;
      if (next !== tag) {
        tag = next;
        applied = false;
      }
      sync();
    },
    setEnabled(next) {
      enabled = next;
      sync();
    },
  };
}

export const NitroListCells = React.memo(function NitroListCells({
  firstPaintLimit,
  dataVersion,
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
  clipItems,
  ItemSeparatorComponent,
  enqueueItemSize,
  cellBridge,
  itemsAreEqual,
  readItemOffset,
  ensureLayout,
  onCommit,
  onMountMarker,
}: NitroListCellsProps) {
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordCellsRender();
  const {range, prewarmRange, reserveRange, dataItems, stickyIndex, autoFixedTypes, renderMode} = useStoreValues(
    store,
    NitroListDevFlags.experimentalSlotPublication ? SLOT_CELLS_STORE_KEYS : CELLS_STORE_KEYS,
  );
  const heldOutputRef = useRef<React.ReactElement | null>(null);
  const publicationRef = useRef<SlotPublisherHandle>(null);
  const publicationToken = {};
  const slotPublication = NitroListDevFlags.experimentalSlotPublication;
  const markerSequence = slotPublication ? store.get('mountSeq') : 0;
  const marker = useMemo(() => slotPublication && Platform.OS === 'android' && onMountMarker != null
    ? <View key="__nitrolist_mount_marker" ref={onMountMarker} testID={String(markerSequence)} collapsable={false} pointerEvents="none" style={styles.mountMarker} />
    : null, [slotPublication, onMountMarker, markerSequence]);
  const committedMarkerRef = useRef(marker);
  const requestCommit = (phase: 'measure' | 'layout' | 'passive') => {
    if ((slotPublication || plan3Holding) && holding) return;
    const commit = () => onCommit(range, prewarmRange, phase);
    if (slotPublication) publicationRef.current?.request(publicationToken, phase, commit);
    else commit();
  };
  const present = (plan: React.ReactElement | null, held = false) => {
    if (!slotPublication || plan == null) return plan;
    const selectedMarker = held ? committedMarkerRef.current : marker;
    const root = plan as React.ReactElement<{children?: readonly React.ReactElement[]}>;
    const published = selectedMarker == null ? root : React.cloneElement(root, undefined, [...(root.props.children ?? []), selectedMarker]);
    return <SlotPublisher ref={publicationRef} token={publicationToken} plan={published} />;
  };
  const originRef = useRef(0);
  const originClipRef = useRef<OriginClip | null>(null);
  originClipRef.current ??= createOriginClip();
  const originClip = originClipRef.current;
  useEffect(() => {
    originClip.setEnabled(clipItems);
  }, [originClip, clipItems]);
  useLayoutEffect(() => {
    requestCommit('measure');
  });
  useLayoutEffect(() => {
    requestCommit('layout');
  }, [range, prewarmRange, onCommit]);
  const initialOverscanCommitLimit = NitroListDevFlags.experimentalInitialOverscanBatch ? firstPaintLimit : 0;
  useEffect(() => {
    requestCommit('passive');
  }, [range, prewarmRange, onCommit, initialOverscanCommitLimit]);

  const renderRanges: RenderRange[] = [];
  pushRenderRange(renderRanges, range, itemCount);
  pushRenderRange(renderRanges, prewarmRange, itemCount);
  pushRenderRange(renderRanges, reserveRange, itemCount);
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
  const focusedIndex = focusedCellIndex(cellBridge, items, keyExtractor);
  if (focusedIndex >= 0 && focusedIndex < itemCount) {
    pushRenderRange(renderRanges, {start: focusedIndex, end: focusedIndex}, itemCount);
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
  const metadataRef = useRef<Map<number, CellMetadata> | null>(
    NitroListDevFlags.experimentalLazyCellRefs ? null : new Map<number, CellMetadata>(),
  );
  if (metadataRef.current === null) metadataRef.current = new Map<number, CellMetadata>();
  const nextMetadata = new Map<number, CellMetadata>();
  const poolRef = useRef<CellPool | null>(NitroListDevFlags.experimentalLazyCellRefs ? null : emptyCellPool());
  if (poolRef.current === null) poolRef.current = emptyCellPool();
  const elementCacheRef = useRef<CellElementCache | null>(
    NitroListDevFlags.experimentalLazyCellRefs ? null : {shared: null, elements: new Map()},
  );
  if (elementCacheRef.current === null) elementCacheRef.current = {shared: null, elements: new Map()};
  const shared: CellSharedProps = {
    recycled: recycleItems,
    flow: false,
    dataVersion,
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
  const plan3Holding = Platform.OS === 'android' && NitroListDevFlags.experimentalPlan3E &&
    store.get('plan3WindowPaused') === true && heldOutputRef.current != null;
  const holding = plan3Holding || (
    dataItems != null &&
    dataItems !== items &&
    heldOutputRef.current != null &&
    keyExtractor != null &&
    rangeKeysMoved(metadataRef.current, items, range, keyExtractor));
  let renderedOutput: React.ReactElement | null = null;
  useInsertionEffect(() => {
    markPlan3Publication(range.start, range.end, plan3Holding, store.get('plan3WindowPaused') === true);
    if (holding) return;
    metadataRef.current = nextMetadata;
    if (nextPool != null) poolRef.current = nextPool;
    cellBridge.freeCells = nextPool != null ? nextPool.order.length - renderedEntryCount : Number.POSITIVE_INFINITY;
    if (IS_DEV && nextPool == null && cellBridge.recycleItemsUnset) {
      cellBridge.createdCells += countNewKeysDev(elementCacheRef.current?.elements ?? new Map(), nextElements);
      maybeWarnRecycleItemsUnset(cellBridge.createdCells);
    }
    elementCacheRef.current = {shared, elements: nextElements};
    heldOutputRef.current = renderedOutput;
    committedMarkerRef.current = marker;
    originRef.current = origin;
  });
  let origin = originRef.current;
  let renderedEntryCount = 0;
  if (holding) return present(heldOutputRef.current, true);

  const seenRenderKeys = IS_DEV ? new Set<string>() : null;
  const entries: CellEntry[] = [];
  let firstTop = Number.POSITIVE_INFINITY;
  let lastTop = Number.NEGATIVE_INFINITY;
  const mergedRanges = mergeRenderRanges(renderRanges);
  for (const {start, end: rangeEnd} of mergedRanges) {
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

  renderedEntryCount = entries.length;
  const anchorTop =
    range != null && range.end >= range.start && range.start < itemCount
      ? readItemOffset(Math.max(0, range.start))
      : firstTop;
  if (Number.isFinite(anchorTop)) origin = nextCellOrigin(origin, anchorTop);
  let flow = NitroListDevFlags.experimentalContiguousFlow && Platform.OS === 'android' &&
    !horizontal && columnLayout == null && resolvedColumns === 1 && mergedRanges.length === 1 &&
    alwaysRender == null && alwaysRenderKeyIndices == null && anchoredEndSpaceAnchor == null &&
    !hideRelatedCell && (stickyIndex == null || stickyIndex < 0) &&
    Number.isFinite(firstTop) && firstTop >= 0 && firstTop < CELL_ORIGIN_SEGMENT * 16;
  if (flow && focusedIndex >= 0) {
    // Yoga needs logical child order. If retained hosts would move, preserve
    // native focus by keeping their physical order in the absolute fallback.
    const committedOrder = new Map<string, number>();
    if (recycleItems) {
      const previousPool = poolRef.current;
      for (let position = 0; position < previousPool.order.length; position++) {
        const slot = previousPool.order[position], key = previousPool.lastKeys.get(slot);
        if (key != null && previousPool.slots.get(key) === slot) committedOrder.set(key, position);
      }
    } else {
      let position = 0;
      for (const key of elementCacheRef.current.elements.keys()) committedOrder.set(key, position++);
    }
    let previousPosition = -1;
    for (const entry of entries) {
      const position = committedOrder.get(entry.metadata.reactKey);
      if (position == null) continue;
      if (position < previousPosition) { flow = false; break; }
      previousPosition = position;
    }
  }
  shared.flow = flow;
  const previousElements = sameCellSharedProps(elementCacheRef.current.shared, shared)
    ? elementCacheRef.current.elements
    : null;
  // Keep the segmented coordinate origin integral. Yoga rounds local positions
  // and absolute sizes separately; a fractional parent origin creates seams.
  if (flow) origin = nextCellOrigin(origin, firstTop);
  const cellOrigin = origin;
  const originStyle = flow ? [styles.flowOrigin, {top: cellOrigin, paddingTop: firstTop - cellOrigin}] : horizontal
    ? [styles.cellOriginHorizontal, {left: origin}]
    : Platform.OS === 'android' && NitroListDevFlags.experimentalTranslatedCellOrigin
      ? [styles.cellOrigin, {top: 0, transform: [{translateY: origin}]}]
      : [styles.cellOrigin, {top: origin}];
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
    origin: cellOrigin,
  };
  if (recycleItems) {
    const previousPool = poolRef.current;
    const assigned = assignCellSlots(
      previousPool,
      entries,
      (slot) => {
        const element = previousPool.elements.get(slot) as
          | React.ReactElement<NitroListItemContainerProps>
          | undefined;
        return (
          element != null &&
          element.props.item === items[element.props.index] &&
          element.props.measurementRevision === measurementRevision
        );
      },
      (slot) =>
        (previousPool.elements.get(slot) as React.ReactElement<NitroListItemContainerProps> | undefined)?.props.index,
      flow && focusedIndex >= 0 ? focusedIndex : undefined,
    );
    nextPool = assigned.pool;
    for (let position = 0; position < entries.length; position++) {
      const slot = assigned.slots[position];
      nextPool.elements.set(slot, buildCellElement(entries[position], `slot-${slot}`, build));
    }
    for (const slot of assigned.parked) {
      const element = previousPool.elements.get(slot)! as React.ReactElement<NitroListItemContainerProps>;
      // Active flow elements may retain an old unused top. Refresh it before
      // the element becomes an absolute parked cell or leaves the flow mode.
      let parkedTop = element.props.top;
      if (element.props.flow === true) {
        ensureLayout(element.props.index, element.props.index);
        parkedTop = readItemOffset(element.props.index);
      }
      const near = parkedTop >= firstTop && parkedTop <= lastTop;
      const parkedElement = flow
        ? React.cloneElement(element, {parked: true, away: true, flow: false, origin: cellOrigin, top: parkedTop})
        : element.props.parked && element.props.flow !== true && (!near || element.props.away) && element.props.origin === origin && element.props.top === parkedTop
          ? element
          : React.cloneElement(element, near ? {parked: true, away: true, flow: false, origin, top: parkedTop} : {parked: true, flow: false, origin, top: parkedTop});
      nextPool.elements.set(slot, parkedElement);
    }
    // Same parent/keys in both modes; active slots follow logical order in Yoga.
    const outputOrder = flow ? [...assigned.slots, ...assigned.parked] : nextPool.order;
    if (flow) nextPool.order = outputOrder;
    const children = new Array<React.ReactElement>(outputOrder.length);
    for (let position = 0; position < outputOrder.length; position++) {
      children[position] = nextPool.elements.get(outputOrder[position])!;
    }
    build.previous = null;
    renderedOutput = (
      <View ref={originClip.attach} collapsable={false} style={originStyle}
        nativeID={NitroListDevFlags.experimentalContiguousFlow ? (flow ? 'nitrolist-research-flow-root' : 'nitrolist-research-absolute-root') : undefined}>
        {children}
      </View>
    );
    return present(renderedOutput);
  }
  const renderedChildren = new Array<React.ReactElement>(entries.length);
  for (let k = 0; k < entries.length; k++) {
    renderedChildren[k] = buildCellElement(entries[k], entries[k].metadata.reactKey, build);
  }
  if (!flow && focusedIndex >= 0) {
    // Moving an existing Android host can clear native input focus even when
    // its key and parent stay the same. Absolute coordinates let retained
    // children keep their committed physical order across data permutations.
    const remaining = new Map(nextElements);
    nextElements.clear();
    let position = 0;
    for (const key of elementCacheRef.current.elements.keys()) {
      const element = remaining.get(key);
      if (element == null) continue;
      renderedChildren[position++] = element;
      nextElements.set(key, element);
      remaining.delete(key);
    }
    for (const [key, element] of remaining) {
      renderedChildren[position++] = element;
      nextElements.set(key, element);
    }
  }
  build.previous = null;
  renderedOutput = (
    <View ref={originClip.attach} collapsable={false} style={originStyle}
        nativeID={NitroListDevFlags.experimentalContiguousFlow ? (flow ? 'nitrolist-research-flow-root' : 'nitrolist-research-absolute-root') : undefined}>
      {renderedChildren}
    </View>
  );
  return present(renderedOutput);
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
  flow?: boolean;
  dataVersion?: unknown;
  parked?: boolean;
  away?: boolean;
  occupant?: string;
  measurementRevision: MeasurementRevision;
  measurementGeometry: number;
  index: number;
  top: number;
  origin: number;
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
    prev.flow === next.flow &&
    Object.is(prev.dataVersion, next.dataVersion) &&
    prev.parked === next.parked &&
    prev.away === next.away &&
    prev.occupant === next.occupant &&
    prev.measurementRevision === next.measurementRevision &&
    prev.measurementGeometry === next.measurementGeometry &&
    ((prev.flow === true && next.flow === true) || prev.top === next.top) &&
    prev.origin === next.origin &&
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
  dataVersion?: unknown;
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
    Object.is(prev.dataVersion, next.dataVersion) &&
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
  flow,
  dataVersion,
  occupant,
  measurementRevision,
  measurementGeometry,
  index,
  top,
  origin,
  horizontal,
  hidden,
  away,
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
    if (flow) return [styles.flowRow, {marginBottom: mainAxisGap}, visibility];
    const position = away ? PARKED_AWAY_OFFSET : top - origin;
    const positionOrigin = Platform.OS === 'android' && !horizontal && NitroListDevFlags.experimentalTranslatedCellOrigin && Math.abs(position) >= 1048576
      ? Math.floor(position / CELL_ORIGIN_SEGMENT) * CELL_ORIGIN_SEGMENT
      : 0;
    const translatedPosition = positionOrigin === 0 ? {} : {transform: [{translateY: positionOrigin}]};
    if (columnLeft != null && columnWidth != null) {
      return [
        styles.absoluteCell,
        {
          top: position - positionOrigin,
          ...translatedPosition,
          left: columnLeft as unknown as number,
          width: columnWidth as unknown as number,
          paddingLeft: crossAxisGap / 2,
          paddingRight: crossAxisGap / 2,
        },
        visibility,
      ];
    }
    return horizontal
      ? [styles.absoluteColumn, {left: position}, visibility]
      : [styles.absoluteRow, {top: position - positionOrigin, ...translatedPosition}, visibility];
  }, [flow, mainAxisGap, horizontal, top, origin, columnLeft, columnWidth, crossAxisGap, hidden, away]);
  const content = (
    <NitroListCellContent
      dataVersion={dataVersion}
      index={index}
      item={item}
      renderItem={renderItem}
      SeparatorComponent={SeparatorComponent}
      isLastItem={isLastItem}
      renderMode={renderMode}
      itemsAreEqual={itemsAreEqual}
    />
  );
  if (Platform.OS === 'android' && NitroListDevFlags.experimentalCompactCell && !NitroListDevFlags.experimentalCellMeasureWidth) {
    return <View ref={record.attachHost} pointerEvents={hidden ? 'none' : undefined}
      onLayout={fixedSize != null && !IS_DEV ? undefined : handleLayout} style={containerStyle}>
      {content}
    </View>;
  }
  return (
    <View pointerEvents={hidden ? 'none' : undefined} style={containerStyle}>
      <View
        ref={record.attachHost}
        onLayout={fixedSize != null && !IS_DEV ? undefined : handleLayout}
        style={NitroListDevFlags.experimentalCellMeasureWidth && !horizontal
          ? [styles.cellMeasure, styles.cellMeasureWidth]
          : styles.cellMeasure}
      >
        {content}
      </View>
    </View>
  );
}, areItemContainerPropsEqual);

export function MountMarkerSlot({store, onMarker}: {store: ListStore; onMarker: (view: View | null) => void}) {
  const sequence = useStoreValue(store, 'mountSeq');
  return <View ref={onMarker} testID={String(sequence)} collapsable={false} pointerEvents="none" style={styles.mountMarker} />;
}

const MVCP_EXTENT_KEYS = ['containerSize', 'endSpace'] as const;

function SpanningMvcpAdjustAnchor({store, top, contentExtra}: {
  store: ListStore; top: number; contentExtra: number;
}) {
  const {containerSize, endSpace} = useStoreValues(store, MVCP_EXTENT_KEYS);
  return <MvcpAdjustAnchor top={top} horizontal={false}
    mainSize={Math.max(1, containerSize + endSpace + contentExtra - top)} />;
}

export function MvcpAdjustAnchorSlot({store, horizontal, contentExtra = 0}: {
  store: ListStore; horizontal: boolean; contentExtra?: number;
}) {
  const mvcpAdjust = useStoreValue(store, 'mvcpAdjust');
  const span = Platform.OS === 'android' && !horizontal && NitroListDevFlags.experimentalSpanningMvcpAnchor;
  return (
    <>
      {MVCP_ANCHOR_BASES.map((base, index) => span && index === MVCP_ANCHOR_BASES.length - 1
        ? <SpanningMvcpAdjustAnchor key={base} store={store} top={base + mvcpAdjust} contentExtra={contentExtra} />
        : <MvcpAdjustAnchor key={base} top={base + mvcpAdjust} horizontal={horizontal} />)}
    </>
  );
}

export const MvcpAdjustAnchor = React.memo(function MvcpAdjustAnchor({
  top,
  horizontal,
  mainSize,
}: {
  top: number;
  horizontal: boolean;
  mainSize?: number;
}) {
  const style = useMemo(
    () => (horizontal ? [styles.mvcpAnchorHorizontal, {left: top}]
      : [styles.mvcpAnchor, mainSize == null ? {top} : {top, height: mainSize}]),
    [horizontal, top, mainSize],
  );
  return <View collapsable={false} pointerEvents={mainSize == null ? undefined : 'none'} style={style} />;
});

export const styles = StyleSheet.create({
  hiddenCell: {
    opacity: 0,
  },
  cellMeasure: {
    flexGrow: 1,
  },
  cellMeasureWidth: {
    width: '100%',
  },
  stickyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  cellOrigin: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  cellOriginHorizontal: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
  },
  flowOrigin: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  flowRow: {
    position: 'relative',
    flexGrow: 0,
    flexShrink: 0,
    width: '100%',
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
  mountMarker: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  },
});
