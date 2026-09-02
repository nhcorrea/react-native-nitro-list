import {PixelRatio} from 'react-native';

import {IS_DEV} from './cells';
import {accumulateEstimateDriftSample, type EstimateDriftStats} from './devWarnings';
import {measurementCacheKey, recordMeasurement} from './measurementCache';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

export const MVCP_POSITION_EPSILON = 0.1;

type Ref<V> = {current: V};
export type ItemTypeKey = string | number;

export interface MeasurementCtx<T> {
  pendingSizesRef: Ref<{buffer: Float64Array; count: number; rafId: number | null}>;
  engineRef: Ref<NitroListEngine | null>;
  mvcpStateRef: Ref<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>;
  mvcpResolvedRef: Ref<{size: boolean; data: boolean}>;
  isPrewarmingRangeRef: Ref<boolean>;
  measurementCtxRef: Ref<{
    items: ReadonlyArray<T>;
    getItemType?: (item: T, index: number) => ItemTypeKey;
    estimatedItemSize: number;
  }>;
  crossViewportRef: Ref<number>;
  columnsRef: Ref<number>;
  autoFixedEnabledRef: Ref<boolean>;
  autoFixedTypesRef: Ref<ReadonlyMap<ItemTypeKey, number>>;
  estimateDriftStatsRef: Ref<Map<string, EstimateDriftStats> | null>;
  freezeAutoFixedTypesRef: Ref<
    (candidates: Set<ItemTypeKey>, widthDp: number, fontScale: number) => void
  >;
  onItemSizeChangedRef: Ref<((info: {index: number; size: number}) => void) | undefined>;
  anchoredEndSpaceRef: Ref<unknown>;
  updateEndSpaceRef: Ref<() => void>;
  refillLayoutCacheRef: Ref<() => void>;
  applyMvcpCorrectionRef: Ref<(diff: number) => void>;
  invalidateLayoutCache: () => void;
  readItemOffset: (index: number) => number;
}

export interface MeasurementApi {
  flush: (emitRange?: boolean) => void;
  enqueue: (index: number, sizeDp: number) => void;
  cancelPending: () => void;
}

export function createMeasurement<T>(ctx: MeasurementCtx<T>): MeasurementApi {
  const flush = (emitRange: boolean = true): void => {
    const state = ctx.pendingSizesRef.current;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    const pairCount = state.count;
    if (pairCount === 0) return;
    const hybrid = ctx.engineRef.current;
    if (!hybrid) {
      return;
    }
    const tight = new Float64Array(pairCount * 2);
    tight.set(state.buffer.subarray(0, pairCount * 2));
    state.count = 0;
    if (NITRO_LIST_PERF_COMPILED) {
      NitroListPerfMonitor.recordBatchFlush(pairCount);
      NitroListPerfMonitor.recordJsiCall();
    }
    const mvcp = ctx.mvcpStateRef.current;
    const anchor =
      mvcp.enabled && ctx.mvcpResolvedRef.current.size && !ctx.isPrewarmingRangeRef.current
        ? mvcp.anchor
        : null;
    ctx.invalidateLayoutCache();
    if (anchor != null) {
      const diff = hybrid.setItemSizesBatchAnchored(tight.buffer, anchor.index, emitRange);
      ctx.refillLayoutCacheRef.current();
      if (Math.abs(diff) > MVCP_POSITION_EPSILON) {
        ctx.applyMvcpCorrectionRef.current(diff);
      }
    } else {
      hybrid.setItemSizesBatch(tight.buffer, emitRange);
      ctx.refillLayoutCacheRef.current();
      const staleAnchor = mvcp.enabled ? mvcp.anchor : null;
      if (staleAnchor != null) {
        staleAnchor.offset = ctx.readItemOffset(staleAnchor.index);
      }
    }
    const sizeChanged = ctx.onItemSizeChangedRef.current;
    if (sizeChanged != null) {
      for (let k = 0; k < pairCount; k++) {
        sizeChanged({index: tight[k * 2] | 0, size: tight[k * 2 + 1]});
      }
    }
    if (ctx.anchoredEndSpaceRef.current != null) {
      ctx.updateEndSpaceRef.current();
    }
    const mctx = ctx.measurementCtxRef.current;
    const widthDp = ctx.crossViewportRef.current / ctx.columnsRef.current;
    const recordToCache = mctx.getItemType != null && widthDp > 0;
    if (recordToCache || IS_DEV) {
      const fontScale = recordToCache ? PixelRatio.getFontScale() : 1;
      let driftStats = ctx.estimateDriftStatsRef.current;
      if (IS_DEV && driftStats == null) {
        driftStats = new Map();
        ctx.estimateDriftStatsRef.current = driftStats;
      }
      const autoFixCandidates =
        recordToCache && ctx.autoFixedEnabledRef.current ? new Set<ItemTypeKey>() : null;
      for (let k = 0; k < pairCount; k++) {
        const idx = tight[k * 2] | 0;
        const item = mctx.items[idx];
        if (item === undefined) continue;
        const type = mctx.getItemType?.(item, idx);
        if (recordToCache) {
          recordMeasurement(
            measurementCacheKey(type as ItemTypeKey, widthDp, fontScale),
            tight[k * 2 + 1],
          );
          if (
            autoFixCandidates != null &&
            type !== undefined &&
            !ctx.autoFixedTypesRef.current.has(type)
          ) {
            autoFixCandidates.add(type);
          }
        }
        if (driftStats != null) {
          accumulateEstimateDriftSample(
            driftStats,
            type != null ? String(type) : '',
            tight[k * 2 + 1],
            mctx.estimatedItemSize,
          );
        }
      }
      if (autoFixCandidates != null && autoFixCandidates.size > 0) {
        ctx.freezeAutoFixedTypesRef.current(autoFixCandidates, widthDp, fontScale);
      }
    }
  };

  const enqueue = (index: number, sizeDp: number): void => {
    const state = ctx.pendingSizesRef.current;
    const neededSlots = (state.count + 1) * 2;
    if (neededSlots > state.buffer.length) {
      const next = new Float64Array(state.buffer.length * 2);
      next.set(state.buffer);
      state.buffer = next;
    }
    const offset = state.count * 2;
    state.buffer[offset] = index;
    state.buffer[offset + 1] = sizeDp;
    state.count++;
    if (state.rafId === null) {
      state.rafId = requestAnimationFrame(() => {
        flush();
      });
    }
  };

  const cancelPending = (): void => {
    const state = ctx.pendingSizesRef.current;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.count = 0;
  };

  return {flush, enqueue, cancelPending};
}
