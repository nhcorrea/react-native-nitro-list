import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

type Ref<V> = {current: V};

export interface LayoutCacheCtx {
  engineRef: Ref<NitroListEngine | null>;
  liveRangeRef: Ref<{start: number; end: number}>;
  estimatedItemSize: number;
  itemCount: number;
}

export interface LayoutCacheApi {
  invalidate: () => void;
  ensureCapacity: (count: number) => void;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  readTotalSize: () => number;
  writeSlab: (slab: Float64Array, written: number) => void;
  fillSlab: (
    expectedStart: number,
    expectedEnd: number,
  ) => {slab: Float64Array; written: number} | null;
  refillIfCold: () => void;
  getSlab: () => Float64Array<ArrayBuffer>;
  growSlab: () => Float64Array<ArrayBuffer>;
}

export function createLayoutCache(ctx: LayoutCacheCtx): LayoutCacheApi {
  const cache = {
    gen: 1,
    capacity: 0,
    tops: new Float64Array(0),
    sizes: new Float64Array(0),
    topsGen: new Int32Array(0),
    sizesGen: new Int32Array(0),
    totalSize: 0,
    totalSizeGen: 0,
  };
  let slab: Float64Array<ArrayBuffer> = new Float64Array(4 + 2 * 64);

  const invalidate = (): void => {
    cache.gen++;
  };

  const ensureCapacity = (count: number): void => {
    if (count <= cache.capacity) return;
    const next = Math.max(count, cache.capacity > 0 ? cache.capacity * 2 : 16);
    const tops = new Float64Array(next);
    const sizes = new Float64Array(next);
    const topsGen = new Int32Array(next);
    const sizesGen = new Int32Array(next);
    if (cache.capacity > 0) {
      tops.set(cache.tops);
      sizes.set(cache.sizes);
      topsGen.set(cache.topsGen);
      sizesGen.set(cache.sizesGen);
    }
    cache.tops = tops;
    cache.sizes = sizes;
    cache.topsGen = topsGen;
    cache.sizesGen = sizesGen;
    cache.capacity = next;
  };

  const readItemOffset = (index: number): number => {
    if (index < 0) return 0;
    const engine = ctx.engineRef.current;
    if (engine == null) return index * ctx.estimatedItemSize;
    if (index < cache.capacity && cache.topsGen[index] === cache.gen) {
      return cache.tops[index];
    }
    const value = engine.getItemOffset(index);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    ensureCapacity(index + 1);
    cache.tops[index] = value;
    cache.topsGen[index] = cache.gen;
    return value;
  };

  const readItemSize = (index: number): number => {
    if (index < 0) return 0;
    const engine = ctx.engineRef.current;
    if (engine == null) return ctx.estimatedItemSize;
    if (index < cache.capacity && cache.sizesGen[index] === cache.gen) {
      return cache.sizes[index];
    }
    const value = engine.getItemSize(index);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    ensureCapacity(index + 1);
    cache.sizes[index] = value;
    cache.sizesGen[index] = cache.gen;
    return value;
  };

  const readTotalSize = (): number => {
    const engine = ctx.engineRef.current;
    if (engine == null) return Math.max(0, ctx.itemCount * ctx.estimatedItemSize);
    if (cache.totalSizeGen === cache.gen) return cache.totalSize;
    const value = engine.getTotalSize();
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    cache.totalSize = value;
    cache.totalSizeGen = cache.gen;
    return value;
  };

  const writeSlab = (source: Float64Array, written: number): void => {
    const start = source[2] | 0;
    ensureCapacity(start + written);
    const gen = cache.gen;
    for (let k = 0; k < written; k++) {
      const i = start + k;
      const base = 4 + 2 * k;
      cache.tops[i] = source[base];
      cache.topsGen[i] = gen;
      cache.sizes[i] = source[base + 1];
      cache.sizesGen[i] = gen;
    }
    cache.totalSize = source[1];
    cache.totalSizeGen = gen;
  };

  const fillSlab = (
    expectedStart: number,
    expectedEnd: number,
  ): {slab: Float64Array; written: number} | null => {
    const engine = ctx.engineRef.current;
    if (!engine) return null;
    const required = 4 + 2 * Math.max(0, expectedEnd - expectedStart + 1) + 16;
    if (slab.length < required) {
      slab = new Float64Array(required);
    }
    let written = engine.fillLayoutSlab(slab.buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    if (written < 0) {
      slab = new Float64Array(slab.length * 2);
      written = engine.fillLayoutSlab(slab.buffer);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) return null;
    }
    return {slab, written};
  };

  const refillIfCold = (): void => {
    if (cache.totalSizeGen === cache.gen) return;
    const live = ctx.liveRangeRef.current;
    const filled = fillSlab(live.start, live.end);
    if (filled == null) return;
    writeSlab(filled.slab, filled.written);
  };

  return {
    invalidate,
    ensureCapacity,
    readItemOffset,
    readItemSize,
    readTotalSize,
    writeSlab,
    fillSlab,
    refillIfCold,
    getSlab: () => slab,
    growSlab: () => {
      slab = new Float64Array(slab.length * 2);
      return slab;
    },
  };
}
