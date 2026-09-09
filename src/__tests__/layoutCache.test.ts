import {expect, it, jest} from '@jest/globals';
import {
  createLayoutCache,
  LAYOUT_MAX_PAGES,
  LAYOUT_PAGE_BYTES,
  type LayoutCacheCtx,
} from '../layoutCache';
import type {NitroListEngine} from '../NitroListEngine.nitro';

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
