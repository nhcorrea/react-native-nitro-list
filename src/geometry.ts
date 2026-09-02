import type {ListStore} from './listStore';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import type {NitroListAnchoredEndSpaceConfig} from './types';

type Ref<V> = {current: V};

export interface GeometryCtx {
  itemCount: number;
  footerSize: number;
  paddingStart: number;
  paddingEnd: number;
  headerSize: number;
  alignItemsAtEnd: boolean;
  snapToIndices?: readonly number[];
  store: ListStore;
  engineRef: Ref<NitroListEngine | null>;
  mainViewportRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  endSpaceRef: Ref<number>;
  contentInsetBottomRef: Ref<number>;
  anchoredEndSpaceRef: Ref<NitroListAnchoredEndSpaceConfig | undefined>;
  anchoredReadyRef: Ref<{anchorIndex: number; fired: boolean}>;
  readTotalSize: () => number;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  setAlignPad: (value: number) => void;
  setSnapOffsets: (updater: (prev: number[] | undefined) => number[] | undefined) => void;
}

export interface GeometryApi {
  getMaxScrollOffset: () => number;
  clampScrollOffset: (offset: number) => number;
  indexAtOffset: (x: number) => number;
  updateAlignPad: () => void;
  updateEndSpace: () => void;
  recomputeSnapOffsets: () => void;
}

export function createGeometry(ctx: GeometryCtx): GeometryApi {
  const getMaxScrollOffset = (): number => {
  const totalSize = ctx.readTotalSize();
  const viewportH = ctx.mainViewportRef.current;
  const totalContent =
    ctx.effectivePaddingStartRef.current + totalSize + ctx.footerSize + ctx.paddingEnd + ctx.endSpaceRef.current;
  return Math.max(0, totalContent - viewportH + ctx.contentInsetBottomRef.current);
  };

  const clampScrollOffset = (offset: number): number =>
    Math.max(0, Math.min(offset, getMaxScrollOffset()));

  const indexAtOffset = (x: number): number => {
    let lo = 0;
    let hi = ctx.itemCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.readItemOffset(mid) <= x) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };

  const updateAlignPad = (): void => {
  if (!ctx.alignItemsAtEnd) {
    ctx.setAlignPad(0);
    return;
  }
  const viewportH = ctx.mainViewportRef.current;
  const content = ctx.paddingStart + ctx.headerSize + ctx.readTotalSize() + ctx.footerSize + ctx.paddingEnd;
  ctx.setAlignPad(Math.max(0, Math.round((viewportH - content) * 8) / 8));
  };

  const updateEndSpace = (): void => {
  const config = ctx.anchoredEndSpaceRef.current;
  if (config == null || ctx.itemCount === 0) {
    if (ctx.endSpaceRef.current !== 0) {
      ctx.endSpaceRef.current = 0;
      ctx.store.set('endSpace', 0);
      config?.onSizeChanged?.(0);
    }
    return;
  }
  const viewportH = ctx.mainViewportRef.current;
  if (viewportH <= 0) return;
  const anchor = Math.max(0, Math.min(Math.trunc(config.anchorIndex), ctx.itemCount - 1));
  let tail = ctx.readTotalSize() - ctx.readItemOffset(anchor);
  const anchorSize = ctx.readItemSize(anchor);
  if (config.anchorMaxSize != null && anchorSize > config.anchorMaxSize) {
    tail -= anchorSize - config.anchorMaxSize;
  }
  const space = Math.max(
    0,
    Math.round(
      (viewportH - (config.anchorOffset ?? 0) - tail - ctx.footerSize - ctx.paddingEnd) * 8,
    ) / 8,
  );
  if (space !== ctx.endSpaceRef.current) {
    ctx.endSpaceRef.current = space;
    ctx.store.set('endSpace', space);
    config.onSizeChanged?.(space);
  }
  const ready = ctx.anchoredReadyRef.current;
  if (ready.anchorIndex !== anchor) {
    ready.anchorIndex = anchor;
    ready.fired = false;
  }
  if (!ready.fired && config.onReady != null) {
    const hybrid = ctx.engineRef.current;
    if (hybrid != null) {
      const unmeasured = hybrid.countUnmeasured(anchor, ctx.itemCount);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (unmeasured === 0) {
        ready.fired = true;
        config.onReady();
      }
    }
  }
  };

  const recomputeSnapOffsets = (): void => {
  if (ctx.snapToIndices == null || ctx.snapToIndices.length === 0 || ctx.itemCount === 0) {
    ctx.setSnapOffsets(() => undefined);
    return;
  }
  const next: number[] = [];
  for (const index of ctx.snapToIndices) {
    if (index < 0 || index >= ctx.itemCount) continue;
    next.push(ctx.effectivePaddingStartRef.current + ctx.readItemOffset(index));
  }
  next.sort((a, b) => a - b);
  ctx.setSnapOffsets((prev) => {
    if (prev != null && prev.length === next.length && prev.every((v, i) => v === next[i])) {
      return prev;
    }
    return next;
  });
  };
  return {
    getMaxScrollOffset,
    clampScrollOffset,
    indexAtOffset,
    updateAlignPad,
    updateEndSpace,
    recomputeSnapOffsets,
  };
}
