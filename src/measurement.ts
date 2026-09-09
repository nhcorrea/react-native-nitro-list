import type {LayoutCacheApi} from './layoutCache';
import {PixelRatio} from 'react-native';

import {IS_DEV} from './cells';
import {accumulateEstimateDriftSample, type EstimateDriftStats} from './devWarnings';
import {measurementCacheKey, recordMeasurement} from './measurementCache';
import {
  isCurrentMeasurement,
  type MeasurementIdentity,
  type MeasurementRevision,
} from './measurementIdentity';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

export const MVCP_POSITION_EPSILON = 0.1;

type Ref<V> = {current: V};
export type ItemTypeKey = string | number;

export interface MeasurementCtx<T> {
  revision: MeasurementRevision;
  dataRevisionRef: Ref<number>;
  layout: LayoutCacheApi;
  consumeSnapshot: (slab: Float64Array, written: number, commitRange?: boolean) => boolean;
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
  measurementCacheDomain: object;
  cacheWidth: () => number;
  cacheEnabled: boolean;
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
  enqueue: (index: number, sizeDp: number, identity?: MeasurementIdentity) => void;
  cancelPending: () => void;
}

export function createMeasurement<T>(ctx: MeasurementCtx<T>): MeasurementApi {
  let identities: MeasurementIdentity[] = [];
  const freeBatches: Float64Array<ArrayBuffer>[] = [];
  const flush = (emitRange: boolean = true): void => {
    const state = ctx.pendingSizesRef.current;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.count === 0) return;
    const hybrid = ctx.engineRef.current;
    if (!hybrid) {
      return;
    }
    const acceptedRevision = ctx.dataRevisionRef.current;
    const accepted = new Map<number, number>();
    const mctx = ctx.measurementCtxRef.current;
    const measurementDomain = ctx.measurementCacheDomain;
    for (let k = 0; k < state.count; k++) {
      const identity = identities[k];
      if (isCurrentMeasurement(identity, mctx.items, ctx.revision)) {
        accepted.set(identity.index, state.buffer[k * 2 + 1]);
      }
    }
    const queuedCount = state.count;
    state.count = 0;
    identities = [];
    const pairCount = accepted.size;
    if (pairCount === 0 || ctx.dataRevisionRef.current !== acceptedRevision) return;
    // Detach the pending buffer before calling anything that can enqueue again.
    const batch = state.buffer as Float64Array<ArrayBuffer>;
    state.buffer = freeBatches.pop() ?? new Float64Array(Math.max(128, batch.length));
    try {
      // The normal unique/valid batch is consumed directly, without copying pairs.
      if (pairCount !== queuedCount) {
        let cursor = 0;
        for (const [index, size] of accepted) {
          batch[cursor++] = index;
          batch[cursor++] = size;
        }
      }
      if (NITRO_LIST_PERF_COMPILED) {
        NitroListPerfMonitor.recordBatchFlush(pairCount);
        NitroListPerfMonitor.recordJsiCall();
      }
      const mvcp = ctx.mvcpStateRef.current;
      const anchor =
        mvcp.enabled && ctx.mvcpResolvedRef.current.size && !ctx.isPrewarmingRangeRef.current
          ? mvcp.anchor
          : null;
      const slab = ctx.layout.getSlab();
      const revision = ctx.dataRevisionRef.current;
      const written = hybrid.setItemSizesAndFill(
        batch.buffer,
        pairCount,
        anchor?.index ?? -1,
        revision,
        slab.buffer,
      );
      if (written === -2) return;
      const delta = slab[9];
      const filled = ctx.layout.completeSnapshot(written);
      if (
        ctx.dataRevisionRef.current !== revision ||
        (filled != null && filled.slab[6] !== revision)
      )
        return;
      if (filled != null) ctx.consumeSnapshot(filled.slab, filled.written, emitRange);
      else ctx.invalidateLayoutCache(); // mutation succeeded; preserve its one-time anchor delta
      if (ctx.dataRevisionRef.current !== revision) return;
      if (anchor != null && Math.abs(delta) > MVCP_POSITION_EPSILON)
        ctx.applyMvcpCorrectionRef.current(delta);
      else if (mvcp.enabled && mvcp.anchor != null)
        mvcp.anchor.offset = ctx.readItemOffset(mvcp.anchor.index);
      if (ctx.anchoredEndSpaceRef.current != null) {
        ctx.updateEndSpaceRef.current();
      }
      const widthDp = ctx.cacheWidth();
      const recordToCache = ctx.cacheEnabled && mctx.getItemType != null && widthDp > 0;
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
          const idx = batch[k * 2] | 0;
          const item = mctx.items[idx];
          if (item === undefined) continue;
          const type = mctx.getItemType?.(item, idx);
          if (ctx.dataRevisionRef.current !== revision) return;
          if (recordToCache) {
            recordMeasurement(
              measurementCacheKey(type as ItemTypeKey, widthDp, fontScale, measurementDomain),
              batch[k * 2 + 1],
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
              batch[k * 2 + 1],
              mctx.estimatedItemSize,
            );
          }
        }
        if (autoFixCandidates != null && autoFixCandidates.size > 0) {
          ctx.freezeAutoFixedTypesRef.current(autoFixCandidates, widthDp, fontScale);
        }
      }
      const sizeChanged = ctx.onItemSizeChangedRef.current;
      if (sizeChanged != null) {
        for (let k = 0; k < pairCount; k++) {
          if (ctx.dataRevisionRef.current !== revision) break;
          sizeChanged({index: batch[k * 2] | 0, size: batch[k * 2 + 1]});
        }
      }
    } finally {
      if (freeBatches.length < 2) freeBatches.push(batch);
    }
  };

  const enqueue = (index: number, sizeDp: number, identity?: MeasurementIdentity): void => {
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(sizeDp) || sizeDp < 0) return;
    const items = ctx.measurementCtxRef.current.items;
    if (identity == null) {
      if (index >= items.length) return;
      identity = {
        index,
        item: items[index],
        revision: ctx.revision,
        geometry: ctx.revision.geometry,
        active: true,
      };
    }
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
    identities[state.count] = identity;
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
    identities = [];
  };

  return {flush, enqueue, cancelPending};
}
