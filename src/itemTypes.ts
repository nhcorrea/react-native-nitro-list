import {PixelRatio} from 'react-native';

import {NitroListDevFlags} from './devFlags';
import {maybeWarnTooManyItemTypes} from './devWarnings';
import {firstDifferingIndex} from './keyRemap';
import {getCachedFixedSize, getCachedMean, measurementCacheKey} from './measurementCache';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

type Ref<V> = {current: V};
export type ItemTypeKey = string | number;

export interface ItemTypesCtx<T> {
  items: ReadonlyArray<T>;
  itemCount: number;
  getItemType?: (item: T, index: number) => ItemTypeKey;
  columnLayout: {spans: Uint16Array} | null;
  engineRef: Ref<NitroListEngine | null>;
  typeIdMapRef: Ref<Map<ItemTypeKey, number>>;
  crossViewportRef: Ref<number>;
  columnsRef: Ref<number>;
  autoFixedEnabledRef: Ref<boolean>;
  autoFixedTypesRef: Ref<ReadonlyMap<ItemTypeKey, number>>;
  commitAutoFixedTypes: (next: Map<ItemTypeKey, number>, pushSizes: boolean) => void;
}

export interface ItemTypesApi {
  seedTypeMeans: () => void;
  pushItemTypes: () => void;
  pushItemSpans: () => void;
  forgetSent: () => void;
}

export function createItemTypes<T>(ctx: ItemTypesCtx<T>): ItemTypesApi {
  let typedCache: {
    items: ReadonlyArray<T>;
    getItemType?: (item: T, index: number) => ItemTypeKey;
    ids: Uint16Array;
  } | null = null;
  let sentTypes: Uint16Array | null = null;
  let sentSpans: Uint16Array | null = null;

  const seedTypeMeans = (): void => {
  const hybrid = ctx.engineRef.current;
  if (!hybrid) return;
  const map = ctx.typeIdMapRef.current;
  const widthDp = ctx.crossViewportRef.current / ctx.columnsRef.current;
  if (map.size === 0 || widthDp <= 0) return;
  const fontScale = PixelRatio.getFontScale();
  let seedCount = 0;
  const seeds = new Float64Array(map.size * 2);
  for (const [type, id] of map) {
    const mean = getCachedMean(measurementCacheKey(type, widthDp, fontScale));
    if (mean != null) {
      seeds[seedCount * 2] = id;
      seeds[seedCount * 2 + 1] = mean;
      seedCount++;
    }
  }
  if (ctx.autoFixedEnabledRef.current) {
    let next: Map<ItemTypeKey, number> | null = null;
    for (const [type] of map) {
      const size = getCachedFixedSize(measurementCacheKey(type, widthDp, fontScale));
      const current = ctx.autoFixedTypesRef.current.get(type);
      if (size != null ? current === size : current == null) continue;
      if (next == null) next = new Map(ctx.autoFixedTypesRef.current);
      if (size != null) {
        next.set(type, size);
      } else {
        next.delete(type);
      }
    }
    if (next != null) ctx.commitAutoFixedTypes(next, true);
  }
  if (seedCount === 0) return;
  hybrid.seedTypeMeans(seeds.slice(0, seedCount * 2).buffer);
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();  };

  const pushItemTypes = (): void => {
  const hybrid = ctx.engineRef.current;
  if (!hybrid || ctx.itemCount === 0) return;
  const typed = typedCache;
  const from =
    NitroListDevFlags.dataAppendFastPath &&
    typed != null &&
    typed.getItemType === ctx.getItemType &&
    typed.ids.length === typed.items.length
      ? Math.min(firstDifferingIndex(typed.items, ctx.items), ctx.itemCount)
      : 0;
  const arr = new Uint16Array(ctx.itemCount);
  if (typed != null && from > 0) arr.set(typed.ids.subarray(0, from));
  if (ctx.getItemType) {
    const map = ctx.typeIdMapRef.current;
    for (let i = from; i < ctx.itemCount; i++) {
      const type = ctx.getItemType(ctx.items[i], i);
      let id = map.get(type);
      if (id == null) {
        id = Math.min(map.size + 1, 65535);
        map.set(type, id);
      }
      arr[i] = id;
    }
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordUserCallbacks(ctx.itemCount - from);
    maybeWarnTooManyItemTypes(map.size);
  }
  typedCache = {items: ctx.items, getItemType: ctx.getItemType, ids: arr};
  const previous = sentTypes;
  let changedFrom = 0;
  if (previous != null) {
    const overlap = Math.min(previous.length, ctx.itemCount);
    changedFrom = Math.min(from, overlap);
    while (changedFrom < overlap && previous[changedFrom] === arr[changedFrom]) changedFrom++;
    if (changedFrom === overlap) {
      while (changedFrom < ctx.itemCount && arr[changedFrom] === 0) changedFrom++;
    }
  }
  sentTypes = arr;
  if (changedFrom >= ctx.itemCount) return;
  const allTracked =
    changedFrom === 0
      ? hybrid.setItemTypes(arr.buffer)
      : hybrid.setItemTypesRange(changedFrom, arr.slice(changedFrom).buffer);
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
  if (!allTracked) maybeWarnTooManyItemTypes(ctx.typeIdMapRef.current.size);
  seedTypeMeans();  };

  const pushItemSpans = (): void => {
  const hybrid = ctx.engineRef.current;
  if (!hybrid) return;
  const spans = ctx.columnLayout != null ? ctx.columnLayout.spans : new Uint16Array(0);
  const last = sentSpans;
  if (last != null && last.length === spans.length) {
    let equal = true;
    for (let i = 0; i < spans.length; i++) {
      if (last[i] !== spans[i]) {
        equal = false;
        break;
      }
    }
    if (equal) return;
  }
  if (last == null && spans.length === 0) {
    sentSpans = spans;
    return;
  }
  sentSpans = spans;
  hybrid.setItemSpans(spans.buffer as ArrayBuffer);
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();  };

  return {
    seedTypeMeans,
    pushItemTypes,
    pushItemSpans,
    forgetSent: () => {
      sentTypes = null;
      sentSpans = null;
    },
  };
}
