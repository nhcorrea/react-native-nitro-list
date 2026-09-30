import {expect, it, jest} from '@jest/globals';
import {
  createLayoutCache,
  LAYOUT_MAX_PAGES,
  LAYOUT_PAGE_BYTES,
  LAYOUT_READ_BYTES,
  type LayoutCacheCtx,
} from '../layoutCache';
import type {NitroListEngine} from '../NitroListEngine.nitro';
import {HybridNitroListEngineMirror} from './helpers/layoutCoreMirror';

it('bounds sparse and sequential page retention, then releases pages on shrink', () => {
  let scale = 100;
  const getItemOffset = jest.fn((index: number) => index * scale);
  const getItemSize = jest.fn(() => scale);
  const ctx: LayoutCacheCtx = {
    engineRef: {
      current: {
        getItemOffset,
        getItemSize,
        getTotalSize: () => ctx.itemCount * scale,
      } as unknown as NitroListEngine,
    },
    liveRangeRef: {current: {start: 0, end: 10}},
    estimatedItemSize: 100,
    itemCount: 100000,
  };
  const cache = createLayoutCache(ctx);
  expect(cache.readItemOffset(95000)).toBe(9500000);
  expect(cache.retainedPageBytes()).toBe(LAYOUT_PAGE_BYTES);
  for (let i = 0; i < 100000; i += 64) {
    expect(cache.readItemOffset(i)).toBe(i * 100);
    expect(cache.readItemSize(i)).toBe(100);
  }
  expect(cache.retainedPageBytes()).toBe(LAYOUT_MAX_PAGES * LAYOUT_PAGE_BYTES);
  getItemOffset.mockClear();
  expect(cache.readItemOffset(0)).toBe(0);
  expect(cache.readItemOffset(0)).toBe(0);
  expect(getItemOffset).toHaveBeenCalledTimes(1);
  scale = 80;
  cache.invalidate();
  expect(cache.readItemOffset(10)).toBe(800);
  expect(cache.readItemSize(10)).toBe(80);
  ctx.itemCount = 100;
  cache.invalidate();
  expect(cache.retainedPageBytes()).toBe(0);
  expect(cache.readTotalSize()).toBe(8000);
  expect(cache.readItemOffset(99)).toBe(7920);
});

it('evicts the least recently used page', () => {
  const getItemOffset = jest.fn((index: number) => index * 100);
  const ctx: LayoutCacheCtx = {
    engineRef: {
      current: {
        getItemOffset,
        getItemSize: () => 100,
        getTotalSize: () => ctx.itemCount * 100,
      } as unknown as NitroListEngine,
    },
    liveRangeRef: {current: {start: 0, end: 10}},
    estimatedItemSize: 100,
    itemCount: 100000,
  };
  const cache = createLayoutCache(ctx);
  for (let page = 0; page < LAYOUT_MAX_PAGES; page++) cache.readItemOffset(page * 64);
  cache.readItemOffset(0);
  cache.readItemOffset(LAYOUT_MAX_PAGES * 64);
  getItemOffset.mockClear();
  cache.readItemOffset(0);
  expect(getItemOffset).not.toHaveBeenCalled();
  cache.readItemOffset(64);
  expect(getItemOffset).toHaveBeenCalledTimes(1);
  expect(cache.retainedPageBytes()).toBe(LAYOUT_MAX_PAGES * LAYOUT_PAGE_BYTES);
});

function mirrorCache(count: number) {
  const engine = new HybridNitroListEngineMirror({typeAverages: false});
  engine.configure(count, 50, 250, false, 1, 0.5);
  const ctx: LayoutCacheCtx = {
    engineRef: {current: engine},
    liveRangeRef: {current: {start: 0, end: -1}},
    estimatedItemSize: 50,
    itemCount: count,
  };
  return {engine, ctx, cache: createLayoutCache(ctx)};
}

const resetReads = (engine: HybridNitroListEngineMirror) => {
  Object.assign(engine.reads, {offset: 0, size: 0, layout: 0, layoutItems: 0});
};

it('reads a cold offset/size pair in one call and serves repeats without the engine', () => {
  const {engine, cache} = mirrorCache(10_000);
  engine.setItemSize(4999, 80);
  resetReads(engine);
  cache.ensureLayout(5000);
  expect(engine.reads).toEqual({offset: 0, size: 0, layout: 1, layoutItems: 1});
  expect(cache.readItemOffset(5000)).toBe(engine.core.getOffset(5000));
  expect(cache.readItemSize(5000)).toBe(50);
  cache.ensureLayout(5000);
  expect(engine.reads).toEqual({offset: 0, size: 0, layout: 1, layoutItems: 1});
});

it('fills only cold runs, never more than one page per call', () => {
  const {engine, cache} = mirrorCache(1000);
  cache.ensureLayout(70, 75);
  resetReads(engine);
  cache.ensureLayout(0, 199);
  expect(engine.reads.layout).toBe(5);
  expect(engine.reads.layoutItems).toBe(194);
  expect(engine.reads.offset + engine.reads.size).toBe(0);
  for (let i = 0; i < 200; i++) {
    expect(cache.readItemOffset(i)).toBe(i * 50);
  }
  expect(engine.reads.offset + engine.reads.size).toBe(0);
  expect(cache.retainedReadBytes()).toBe(LAYOUT_READ_BYTES);
});

it('drops values from an older layout version instead of mixing them with a newer read', () => {
  const {engine, cache} = mirrorCache(1000);
  cache.ensureLayout(10);
  expect(cache.readItemOffset(10)).toBe(500);
  engine.setItemSize(3, 250);
  cache.ensureLayout(700);
  resetReads(engine);
  expect(cache.readItemOffset(10)).toBe(700);
  expect(cache.readItemOffset(10)).toBe(engine.core.getOffset(10));
  expect(cache.readItemSize(10)).toBe(50);
  expect(engine.reads.offset + engine.reads.size + engine.reads.layout).toBeGreaterThan(0);
});

it('ignores invalid ranges, empty lists and failed reads without caching garbage', () => {
  const {engine, ctx, cache} = mirrorCache(100);
  resetReads(engine);
  cache.ensureLayout(-5);
  cache.ensureLayout(100);
  cache.ensureLayout(10, 5);
  expect(engine.reads.layout).toBe(0);
  const failing = jest.spyOn(engine, 'readLayout').mockReturnValueOnce(-2);
  cache.ensureLayout(20);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(cache.readItemOffset(20)).toBe(1000);
  expect(engine.reads.offset).toBe(1);
  failing.mockRestore();
  ctx.itemCount = 0;
  cache.invalidate();
  resetReads(engine);
  cache.ensureLayout(0, 10);
  expect(engine.reads.layout).toBe(0);
});

it('keeps the page cap under range reads and releases the read buffer on detach', () => {
  const {engine, ctx, cache} = mirrorCache(100_000);
  for (let i = 0; i < 100_000; i += 997) cache.ensureLayout(i, i + 100);
  expect(cache.retainedPageBytes()).toBe(LAYOUT_MAX_PAGES * LAYOUT_PAGE_BYTES);
  expect(cache.retainedReadBytes()).toBe(LAYOUT_READ_BYTES);
  expect(cache.readItemOffset(95_000)).toBe(95_000 * 50);
  ctx.itemCount = 100;
  cache.invalidate();
  expect(cache.retainedPageBytes()).toBe(0);
  ctx.engineRef.current = null;
  cache.invalidate();
  expect(cache.retainedReadBytes()).toBe(0);
  expect(engine.reads.layout).toBeGreaterThan(0);
});
