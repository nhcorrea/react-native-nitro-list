import type {NitroListViewabilityConfig} from './NitroList';

export function isItemViewable(
  itemTop: number,
  itemHeight: number,
  viewportTop: number,
  viewportHeight: number,
  config: NitroListViewabilityConfig,
): boolean {
  if (itemHeight <= 0 || viewportHeight <= 0) return false;
  const itemBottom = itemTop + itemHeight;
  const viewportBottom = viewportTop + viewportHeight;
  const visibleTop = Math.max(itemTop, viewportTop);
  const visibleBottom = Math.min(itemBottom, viewportBottom);
  const visibleHeight = visibleBottom - visibleTop;
  if (visibleHeight <= 0) return false;

  if (itemTop >= viewportTop && itemBottom <= viewportBottom) {
    return true;
  }

  const {viewAreaCoveragePercentThreshold, itemVisiblePercentThreshold} = config;
  if (viewAreaCoveragePercentThreshold != null) {
    return (visibleHeight / viewportHeight) * 100 >= viewAreaCoveragePercentThreshold;
  }
  if (itemVisiblePercentThreshold != null) {
    return (visibleHeight / itemHeight) * 100 >= itemVisiblePercentThreshold;
  }
  return true;
}


export const VIEWABILITY_MIN_OFFSET_DELTA = 3;

type Ref<V> = {current: V};

export interface ViewToken<T> {
  item: T;
  key: string;
  index: number | null;
  isViewable: boolean;
  timestamp: number;
}

export interface ViewabilityScratch<T> {
  potential: Set<number>;
  pendingKeysSnapshot: number[];
  removed: ViewToken<T>[];
  newlyViewable: ViewToken<T>[];
}

export interface ViewabilityCtx<T> {
  items: ReadonlyArray<T>;
  keyExtractor?: (item: T, index: number) => string;
  config?: NitroListViewabilityConfig;
  onViewableItemsChanged?: (info: {
    viewableItems: ViewToken<T>[];
    changed: ViewToken<T>[];
  }) => void;
  hasEngine: () => boolean;
  viewableRef: Ref<Map<number, ViewToken<T>>>;
  pendingRef: Ref<Map<number, number>>;
  scratchRef: Ref<ViewabilityScratch<T>>;
  lastEvalRef: Ref<{offset: number; start: number; end: number; layoutVersion: number}>;
  committedRangeRef: Ref<{start: number; end: number; layoutVersion: number}>;
  timerRef: Ref<ReturnType<typeof setTimeout> | null>;
  hasInteractedRef: Ref<boolean>;
  mainViewportRef: Ref<number>;
  lastScrollOffsetRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  ensureLayout: (start: number, end?: number) => void;
  reschedule: () => void;
}

export function createViewability<T>(ctx: ViewabilityCtx<T>): () => void {
  const previous: {
    items: ReadonlyArray<T> | null;
    keyExtractor: ViewabilityCtx<T>['keyExtractor'];
    callback: ViewabilityCtx<T>['onViewableItemsChanged'];
    minimumViewTime: number;
    waitForInteraction: boolean;
    itemThreshold: number | undefined;
    areaThreshold: number | undefined;
    viewport: number;
    padding: number;
    interacted: boolean;
  } = {
    items: null,
    keyExtractor: undefined,
    callback: undefined,
    minimumViewTime: 0,
    waitForInteraction: false,
    itemThreshold: undefined,
    areaThreshold: undefined,
    viewport: 0,
    padding: 0,
    interacted: false,
  };
  let hasPrevious = false;
  let timerDeadline = Number.NaN;
  const reschedule = (): void => {
    ctx.timerRef.current = null;
    ctx.reschedule();
  };
  const forget = (): void => {
    hasPrevious = false;
    previous.items = null;
    previous.keyExtractor = undefined;
    previous.callback = undefined;
  };
  return function evaluate(): void {
    const cb = ctx.onViewableItemsChanged;
    const config = ctx.config;
    const viewable = ctx.viewableRef.current;
    const pending = ctx.pendingRef.current;
    if (!cb || !config) {
      forget();
      if (viewable.size > 0) viewable.clear();
      if (pending.size > 0) pending.clear();
      if (ctx.timerRef.current != null) clearTimeout(ctx.timerRef.current);
      ctx.timerRef.current = null;
      return;
    }
    const viewportH = ctx.mainViewportRef.current;
    const offset = ctx.lastScrollOffsetRef.current - ctx.effectivePaddingStartRef.current;
    if (!ctx.hasEngine() || viewportH <= 0) return;

    const items = ctx.items;
    const keyExtractor = ctx.keyExtractor;
    const minimumViewTime = config.minimumViewTime ?? 0;
    const waitForInteraction = config.waitForInteraction ?? false;
    const subscriberChanged = hasPrevious && previous.callback !== cb;
    const dataChanged = hasPrevious && (previous.items !== items || previous.keyExtractor !== keyExtractor);
    const configChanged = hasPrevious && (
      previous.minimumViewTime !== minimumViewTime || previous.waitForInteraction !== waitForInteraction ||
      previous.itemThreshold !== config.itemVisiblePercentThreshold ||
      previous.areaThreshold !== config.viewAreaCoveragePercentThreshold
    );
    const inputsChanged = !hasPrevious || subscriberChanged || dataChanged || configChanged ||
      previous.viewport !== viewportH || previous.padding !== ctx.effectivePaddingStartRef.current ||
      previous.interacted !== ctx.hasInteractedRef.current;
    if (subscriberChanged) viewable.clear();
    // Time qualified against old keys/thresholds cannot qualify the new contract.
    if (subscriberChanged || dataChanged || configChanged) pending.clear();

    const committedRange = ctx.committedRangeRef.current;
    const start = Math.max(0, committedRange.start);
    const end = Math.min(committedRange.end, items.length - 1);

    const last = ctx.lastEvalRef.current;
    const layoutVersion = committedRange.layoutVersion;
    const rangeMoved = last.start !== start || last.end !== end;
    const layoutShifted = last.layoutVersion !== layoutVersion;
    const offsetDelta = Math.abs(offset - last.offset);
    const hasPending = pending.size > 0;
    if (
      !rangeMoved &&
      !inputsChanged &&
      !layoutShifted &&
      !hasPending &&
      Number.isFinite(last.offset) &&
      offsetDelta < VIEWABILITY_MIN_OFFSET_DELTA
    ) {
      return;
    }
    last.offset = offset;
    last.start = start;
    last.end = end;
    last.layoutVersion = layoutVersion;
    hasPrevious = true;
    previous.items = items;
    previous.keyExtractor = keyExtractor;
    previous.callback = cb;
    previous.minimumViewTime = minimumViewTime;
    previous.waitForInteraction = waitForInteraction;
    previous.itemThreshold = config.itemVisiblePercentThreshold;
    previous.areaThreshold = config.viewAreaCoveragePercentThreshold;
    previous.viewport = viewportH;
    previous.padding = ctx.effectivePaddingStartRef.current;
    previous.interacted = ctx.hasInteractedRef.current;

    const scratch = ctx.scratchRef.current;
    const potential = scratch.potential;
    potential.clear();
    if (!waitForInteraction || ctx.hasInteractedRef.current) {
      ctx.ensureLayout(start, end);
      for (let i = start; i <= end; i++) {
        const top = ctx.readItemOffset(i);
        const h = ctx.readItemSize(i);
        if (isItemViewable(top, h, offset, viewportH, config)) {
          potential.add(i);
        }
      }
    }

    const now = Date.now();

    const pendingKeys = scratch.pendingKeysSnapshot;
    pendingKeys.length = 0;
    for (const idx of pending.keys()) pendingKeys.push(idx);
    for (let i = 0; i < pendingKeys.length; i++) {
      const idx = pendingKeys[i];
      if (!potential.has(idx)) pending.delete(idx);
    }

    const newlyViewable = scratch.newlyViewable;
    newlyViewable.length = 0;
    const removed = scratch.removed;
    removed.length = 0;
    if (dataChanged) {
      for (const [idx, token] of viewable) {
        const item = items[idx];
        const key = idx < items.length ? (keyExtractor ? keyExtractor(item, idx) : String(idx)) : null;
        if (token.key !== key || token.item !== item) {
          removed.push({...token, isViewable: false, timestamp: now});
          viewable.delete(idx);
        }
      }
    }
    for (const idx of potential) {
      if (viewable.has(idx)) continue;
      if (minimumViewTime <= 0) {
        pending.delete(idx);
      } else {
        const since = pending.get(idx);
        if (since == null) {
          pending.set(idx, now);
          continue;
        }
        if (now - since < minimumViewTime) continue;
        pending.delete(idx);
      }
      const item = items[idx];
      const key = keyExtractor ? keyExtractor(item, idx) : String(idx);
      newlyViewable.push({item, key, index: idx, isViewable: true, timestamp: now});
    }

    for (const [idx, tok] of viewable) {
      if (!potential.has(idx)) {
        removed.push({...tok, isViewable: false, timestamp: now});
      }
    }
    for (let i = 0; i < removed.length; i++) {
      const tok = removed[i];
      if (tok.index != null) viewable.delete(tok.index);
    }
    for (let i = 0; i < newlyViewable.length; i++) {
      const tok = newlyViewable[i];
      if (tok.index != null) viewable.set(tok.index, tok);
    }

    let earliest = Number.NaN;
    if (pending.size > 0 && minimumViewTime > 0) {
      earliest = Infinity;
      for (const since of pending.values()) {
        const deadline = since + minimumViewTime;
        if (deadline < earliest) earliest = deadline;
      }
    }
    if (ctx.timerRef.current == null || earliest !== timerDeadline) {
      if (ctx.timerRef.current != null) clearTimeout(ctx.timerRef.current);
      ctx.timerRef.current = null;
      timerDeadline = earliest;
      if (!Number.isNaN(earliest)) {
        ctx.timerRef.current = setTimeout(reschedule, Math.max(0, earliest - now));
      }
    }

    if (removed.length > 0 || newlyViewable.length > 0) {
      const viewableItems = Array.from(viewable.values());
      cb({viewableItems, changed: [...removed, ...newlyViewable]});
    }
  };
}
