import {PixelRatio} from 'react-native';

import {NitroListDevFlags} from './devFlags';
import {maybeWarnTooManyItemTypes} from './devWarnings';
import type {DataAnalysis} from './dataAnalysis';
import {getCachedFixedSize, getCachedMean, measurementCacheKey} from './measurementCache';
import {nativeFloat64Array, nativeUint16Array} from './nativeBuffers';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

type Ref<V> = {current: V};
export type ItemTypeKey = string | number;

export interface ItemTypesCtx<T> {
  analysis: DataAnalysis<T>;
  items: ReadonlyArray<T>;
  itemCount: number;
  getItemType?: (item: T, index: number) => ItemTypeKey;
  columnLayout: {spans: Uint16Array} | null;
  engineRef: Ref<NitroListEngine | null>;
  typeIdMapRef: Ref<Map<ItemTypeKey, number>>;
  crossViewportRef: Ref<number>;
  columnsRef: Ref<number>;
  measurementCacheDomain: object;
  cacheWidth: () => number;
  cacheEnabled: boolean;
  autoFixedEnabledRef: Ref<boolean>;
  autoFixedTypesRef: Ref<ReadonlyMap<ItemTypeKey, number>>;
  commitAutoFixedTypes: (next: Map<ItemTypeKey, number>, pushSizes: boolean) => void;
}

export interface ItemTypesApi {
  seedTypeMeans: () => void;
  forgetSent: () => void;
  prepareTypes: () => {
    types: Uint16Array<ArrayBuffer>;
    start: number;
    count: number;
    offset: number;
  };
}

export function createItemTypes<T>(ctx: ItemTypesCtx<T>): ItemTypesApi {
  let typedItems: ReadonlyArray<T> | null = null;
  let typedWithCallback = false;
  let typeBuffer: Uint16Array<ArrayBuffer> | null = null;
  let sentCount = -1;

  const seedTypeMeans = (): void => {
    const hybrid = ctx.engineRef.current;
    if (!hybrid) return;
    const map = ctx.typeIdMapRef.current;
    const widthDp = ctx.cacheWidth();
    if (!ctx.cacheEnabled || map.size === 0 || widthDp <= 0) return;
    const fontScale = PixelRatio.getFontScale();
    let seedCount = 0;
    const seeds = new Float64Array(map.size * 2);
    for (const [type, id] of map) {
      const mean = getCachedMean(
        measurementCacheKey(type, widthDp, fontScale, ctx.measurementCacheDomain),
      );
      if (mean != null) {
        seeds[seedCount * 2] = id;
        seeds[seedCount * 2 + 1] = mean;
        seedCount++;
      }
    }
    if (ctx.autoFixedEnabledRef.current) {
      let next: Map<ItemTypeKey, number> | null = null;
      for (const [type] of map) {
        const size = getCachedFixedSize(
          measurementCacheKey(type, widthDp, fontScale, ctx.measurementCacheDomain),
        );
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
    const pairs = nativeFloat64Array(seedCount * 2);
    pairs.set(seeds.subarray(0, seedCount * 2));
    hybrid.seedTypeMeans(pairs.buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
  };

  const prepareTypes = (): {
    types: Uint16Array<ArrayBuffer>;
    start: number;
    count: number;
    offset: number;
  } => {
    const from =
      NitroListDevFlags.dataAppendFastPath &&
      typedItems != null &&
      typedWithCallback === (ctx.getItemType != null) &&
      !ctx.analysis.versionChanged
        ? typedItems === ctx.items
          ? ctx.itemCount
          : ctx.analysis.firstChanged
        : 0;
    if (typeBuffer == null) {
      typeBuffer = nativeUint16Array(Math.max(ctx.itemCount, 64));
    } else if (typeBuffer.length > Math.max(64, ctx.itemCount * 4)) {
      const next = nativeUint16Array(Math.max(64, ctx.itemCount));
      next.set(typeBuffer.subarray(0, next.length));
      typeBuffer = next;
    } else if (typeBuffer.length < ctx.itemCount) {
      const next = nativeUint16Array(Math.max(ctx.itemCount, typeBuffer.length * 2, 64));
      next.set(typeBuffer);
      typeBuffer = next;
    }
    const buffer = typeBuffer;
    let changedFrom = sentCount < 0 ? 0 : ctx.itemCount;
    const map = ctx.typeIdMapRef.current;
    for (let i = from; i < ctx.itemCount; ++i) {
      let id = 0;
      if (ctx.getItemType != null) {
        const type = ctx.getItemType(ctx.items[i], i);
        const found = map.get(type);
        id = found ?? Math.min(map.size + 1, 65535);
        if (found == null) map.set(type, id);
      }
      if (buffer[i] !== id || (i >= sentCount && id !== 0))
        changedFrom = Math.min(changedFrom, i);
      buffer[i] = id;
    }
    maybeWarnTooManyItemTypes(map.size);
    typedItems = ctx.items;
    typedWithCallback = ctx.getItemType != null;
    sentCount = ctx.itemCount;
    return {
      types: buffer,
      start: changedFrom >= ctx.itemCount ? -1 : changedFrom,
      count: Math.max(0, ctx.itemCount - changedFrom),
      offset: changedFrom,
    };
  };

  return {
    prepareTypes,
    seedTypeMeans,
    forgetSent: () => {
      sentCount = -1;
    },
  };
}
