import {
  LAYOUT_READ_HEADER,
  SNAPSHOT_HEADER,
  validLayoutRead,
  validSnapshot,
} from './layoutSnapshot';
import {nativeFloat64Array} from './nativeBuffers';
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
  retainedPageBytes: () => number;
  hasCurrentSnapshot: () => boolean;
  retainedReadBytes: () => number;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  ensureLayout: (start: number, end?: number) => void;
  readTotalSize: () => number;
  writeSlab: (slab: Float64Array, written: number) => void;
  fillSlab: (
    expectedStart: number,
    expectedEnd: number,
  ) => {slab: Float64Array; written: number} | null;
  refillIfCold: () => void;
  completeSnapshot: (written: number) => {slab: Float64Array; written: number} | null;
  getSlab: () => Float64Array<ArrayBuffer>;
}

export const LAYOUT_PAGE_ITEMS = 64;
export const LAYOUT_MAX_PAGES = 64;
export const LAYOUT_PAGE_BYTES = LAYOUT_PAGE_ITEMS * (8 + 8 + 1);
export const LAYOUT_READ_BYTES = (LAYOUT_READ_HEADER + 2 * LAYOUT_PAGE_ITEMS) * 8;

type Page = {generation: number; tops: Float64Array; sizes: Float64Array; valid: Uint8Array};

export function createLayoutCache(ctx: LayoutCacheCtx): LayoutCacheApi {
  const pages = new Map<number, Page>();
  let generation = 1;
  let lastPageKey = -1;
  let lastPage: Page | null = null;
  let totalSize = 0;
  let totalGeneration = 0;
  let snapshotGeneration = 0;
  let previousCount = ctx.itemCount;
  let slab: Float64Array<ArrayBuffer> = nativeFloat64Array(SNAPSHOT_HEADER + 2 * 64);
  let readBuffer: Float64Array<ArrayBuffer> | null = null;
  let knownGeneration = 0;
  let knownVersion = 0;
  let knownRevision = 0;

  const invalidate = (): void => {
    ++generation;
    lastPage = null;
    if (ctx.itemCount < previousCount || ctx.engineRef.current == null) {
      pages.clear();
      if (slab.length > SNAPSHOT_HEADER + 2 * 64) slab = nativeFloat64Array(SNAPSHOT_HEADER + 2 * 64);
    }
    if (ctx.engineRef.current == null) readBuffer = null;
    previousCount = ctx.itemCount;
  };

  const pageFor = (index: number): Page => {
    const key = Math.floor(index / LAYOUT_PAGE_ITEMS);
    if (lastPageKey === key && lastPage != null) return lastPage;
    let page = pages.get(key);
    if (page != null) {
      pages.delete(key);
    } else if (pages.size >= LAYOUT_MAX_PAGES) {
      const oldest = pages.keys().next().value!;
      page = pages.get(oldest)!;
      pages.delete(oldest);
      page.generation = -1;
    } else {
      page = {
        generation: -1,
        tops: new Float64Array(LAYOUT_PAGE_ITEMS),
        sizes: new Float64Array(LAYOUT_PAGE_ITEMS),
        valid: new Uint8Array(LAYOUT_PAGE_ITEMS),
      };
    }
    if (page.generation !== generation) {
      page.valid.fill(0);
      page.generation = generation;
    }
    pages.set(key, page);
    lastPageKey = key;
    lastPage = page;
    return page;
  };

  const readItemOffset = (index: number): number => {
    if (index < 0) return 0;
    const engine = ctx.engineRef.current;
    if (engine == null) return index * ctx.estimatedItemSize;
    const page = pageFor(index),
      slot = index % LAYOUT_PAGE_ITEMS;
    if ((page.valid[slot] & 1) !== 0) return page.tops[slot];
    const value = engine.getItemOffset(index);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    page.tops[slot] = value;
    page.valid[slot] |= 1;
    return value;
  };

  const readItemSize = (index: number): number => {
    if (index < 0) return 0;
    const engine = ctx.engineRef.current;
    if (engine == null) return ctx.estimatedItemSize;
    const page = pageFor(index),
      slot = index % LAYOUT_PAGE_ITEMS;
    if ((page.valid[slot] & 2) !== 0) return page.sizes[slot];
    const value = engine.getItemSize(index);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    page.sizes[slot] = value;
    page.valid[slot] |= 2;
    return value;
  };

  const noteLayout = (version: number, revision: number): void => {
    if (knownGeneration === generation && (knownVersion !== version || knownRevision !== revision)) {
      ++generation;
      lastPage = null;
    }
    knownGeneration = generation;
    knownVersion = version;
    knownRevision = revision;
  };

  const readRun = (engine: NitroListEngine, start: number, count: number): void => {
    readBuffer ??= nativeFloat64Array(LAYOUT_READ_HEADER + 2 * LAYOUT_PAGE_ITEMS);
    const buffer = readBuffer;
    const written = engine.readLayout(start, count, buffer.buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    if (!validLayoutRead(buffer, written, start)) return;
    noteLayout(buffer[4], buffer[2]);
    if (written === 0) return;
    const page = pageFor(start),
      first = start % LAYOUT_PAGE_ITEMS;
    for (let k = 0; k < written; ++k) {
      page.tops[first + k] = buffer[LAYOUT_READ_HEADER + k * 2];
      page.sizes[first + k] = buffer[LAYOUT_READ_HEADER + k * 2 + 1];
      page.valid[first + k] = 3;
    }
    totalSize = buffer[5];
    totalGeneration = generation;
  };

  const ensureLayout = (start: number, end: number = start): void => {
    const engine = ctx.engineRef.current;
    if (engine == null) return;
    const last = Math.min(end, ctx.itemCount - 1);
    let index = Math.max(0, start);
    while (index <= last) {
      const page = pageFor(index),
        slot = index % LAYOUT_PAGE_ITEMS;
      if (page.valid[slot] === 3) {
        ++index;
        continue;
      }
      const pageLast = Math.min(last, index - slot + LAYOUT_PAGE_ITEMS - 1);
      let runEnd = index;
      while (runEnd < pageLast && page.valid[(runEnd + 1) % LAYOUT_PAGE_ITEMS] !== 3) ++runEnd;
      readRun(engine, index, runEnd - index + 1);
      index = runEnd + 1;
    }
  };

  const readTotalSize = (): number => {
    const engine = ctx.engineRef.current;
    if (engine == null) return Math.max(0, ctx.itemCount * ctx.estimatedItemSize);
    if (totalGeneration === generation) return totalSize;
    totalSize = engine.getTotalSize();
    totalGeneration = generation;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    return totalSize;
  };

  const writeSlab = (source: Float64Array, written: number): void => {
    if (!validSnapshot(source, written)) return;
    noteLayout(source[0], source[6]);
    const start = source[2];
    for (let k = 0; k < written; ++k) {
      const index = start + k,
        page = pageFor(index),
        slot = index % LAYOUT_PAGE_ITEMS;
      page.tops[slot] = source[SNAPSHOT_HEADER + k * 2];
      page.sizes[slot] = source[SNAPSHOT_HEADER + k * 2 + 1];
      page.valid[slot] = 3;
    }
    snapshotGeneration = generation;
    totalSize = source[1];
    totalGeneration = generation;
  };

  const completeSnapshot = (written: number): {slab: Float64Array; written: number} | null => {
    const engine = ctx.engineRef.current;
    if (engine == null) return null;
    if (written === -1 && slab[11] > slab.length) {
      const sequence = slab[7];
      slab = nativeFloat64Array(Math.max(slab.length * 2, slab[11]));
      written = engine.readSnapshot(sequence, slab.buffer);
    }
    // Another runtime may have published in between. Read current state; never replay a mutation.
    for (let attempt = 0; written < 0 && attempt < 3; ++attempt) {
      if (slab[11] > slab.length) slab = nativeFloat64Array(Math.max(slab.length * 2, slab[11]));
      written = engine.fillLayoutSlab(slab.buffer);
    }
    return validSnapshot(slab, written) ? {slab, written} : null;
  };

  const fillSlab = (
    expectedStart: number,
    expectedEnd: number,
  ): {slab: Float64Array; written: number} | null => {
    const engine = ctx.engineRef.current;
    if (!engine) return null;
    const required =
      SNAPSHOT_HEADER +
      2 * Math.min(ctx.itemCount, Math.max(0, expectedEnd - expectedStart + 1)) +
      16;
    if (slab.length < required) {
      slab = nativeFloat64Array(required);
    }
    const written = engine.fillLayoutSlab(slab.buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    return completeSnapshot(written);
  };

  const refillIfCold = (): void => {
    if (totalGeneration === generation) return;
    const live = ctx.liveRangeRef.current;
    const filled = fillSlab(live.start, live.end);
    if (filled == null) return;
    writeSlab(filled.slab, filled.written);
  };

  return {
    invalidate,
    retainedPageBytes: () => pages.size * LAYOUT_PAGE_BYTES,
    retainedReadBytes: () => (readBuffer == null ? 0 : readBuffer.byteLength),
    hasCurrentSnapshot: () => snapshotGeneration === generation,
    readItemOffset,
    readItemSize,
    ensureLayout,
    readTotalSize,
    writeSlab,
    fillSlab,
    refillIfCold,
    completeSnapshot,
    getSlab: () => slab,
  };
}
