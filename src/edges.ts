export const EDGE_HYSTERESIS_MULTIPLIER = 1.3;

export type EdgeLatchState = {
  isReached: boolean;
  contentSize: number;
  dataLength: number;
};

export function checkEdgeThreshold(
  state: EdgeLatchState,
  distance: number,
  thresholdDistance: number,
  contentSize: number,
  dataLength: number,
  allowRearm: boolean,
  fire: (distance: number) => void,
): void {
  if (!state.isReached) {
    if (distance <= thresholdDistance) {
      state.isReached = true;
      state.contentSize = contentSize;
      state.dataLength = dataLength;
      fire(distance);
    }
    return;
  }
  if (distance > thresholdDistance * EDGE_HYSTERESIS_MULTIPLIER) {
    if (allowRearm) {
      state.isReached = false;
    }
    return;
  }
  if (
    distance <= thresholdDistance &&
    (state.contentSize !== contentSize || state.dataLength !== dataLength)
  ) {
    state.contentSize = contentSize;
    state.dataLength = dataLength;
    fire(distance);
  }
}


type Ref<V> = {current: V};

export interface EdgeCallbacksCtx {
  onEndReached?: (info: {distanceFromEnd: number}) => void;
  onStartReached?: (info: {distanceFromStart: number}) => void;
  onEndReachedThreshold?: number;
  onStartReachedThreshold?: number;
  footerSize: number;
  paddingEnd: number;
  suppressEdgeRearmRef: Ref<boolean>;
  anchoredEndSpaceRef: Ref<unknown>;
  maintainAtEndRef: Ref<{threshold: number; animated: boolean} | null>;
  itemCountRef: Ref<number>;
  mainViewportRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  endSpaceRef: Ref<number>;
  lastScrollOffsetRef: Ref<number>;
  stickToEndRef: Ref<{
    pending: boolean;
    regrow: boolean;
    wasAtEnd: boolean;
    lastContent: number;
  }>;
  scrollActivityRef: Ref<{dragging: boolean; momentum: boolean}>;
  endEdgeStateRef: Ref<EdgeLatchState>;
  startEdgeStateRef: Ref<EdgeLatchState>;
  readTotalSize: () => number;
  scheduleStickToEnd: (animated: boolean) => void;
}

export function createEdgeCallbacks(ctx: EdgeCallbacksCtx): () => void {
  return function checkEdgeCallbacks(): void {
  const allowRearm = !ctx.suppressEdgeRearmRef.current;
  ctx.suppressEdgeRearmRef.current = false;
  const maintain = ctx.anchoredEndSpaceRef.current == null ? ctx.maintainAtEndRef.current : null;
  if (!ctx.onEndReached && !ctx.onStartReached && maintain == null) return;
  const liveItemCount = ctx.itemCountRef.current;
  const viewportH = ctx.mainViewportRef.current;
  if (viewportH <= 0 || liveItemCount === 0) return;
  const totalContent =
    ctx.effectivePaddingStartRef.current +
    ctx.readTotalSize() +
    ctx.footerSize +
    ctx.paddingEnd +
    ctx.endSpaceRef.current;
  const scrollY = ctx.lastScrollOffsetRef.current;
  if (maintain != null) {
    const stick = ctx.stickToEndRef.current;
    const contentGrew = totalContent > stick.lastContent + 1;
    if (!contentGrew) {
      if (!stick.pending) {
        stick.wasAtEnd =
          totalContent - scrollY - viewportH <= maintain.threshold * viewportH ||
          totalContent <= viewportH;
      }
    } else if (stick.pending) {
      stick.regrow = true;
    } else if (stick.wasAtEnd) {
      const activity = ctx.scrollActivityRef.current;
      if (!activity.dragging && !activity.momentum) {
        ctx.scheduleStickToEnd(maintain.animated);
      }
    }
    stick.lastContent = totalContent;
  }
  if (ctx.onEndReached) {
    checkEdgeThreshold(
      ctx.endEdgeStateRef.current,
      totalContent - scrollY - viewportH,
      (ctx.onEndReachedThreshold ?? 0.5) * viewportH,
      totalContent,
      liveItemCount,
      allowRearm,
      (distanceFromEnd) => ctx.onEndReached?.({distanceFromEnd}),
    );
  } else {
    ctx.endEdgeStateRef.current.isReached = false;
  }
  if (ctx.onStartReached) {
    checkEdgeThreshold(
      ctx.startEdgeStateRef.current,
      scrollY,
      (ctx.onStartReachedThreshold ?? 0.5) * viewportH,
      totalContent,
      liveItemCount,
      allowRearm,
      (distanceFromStart) => ctx.onStartReached?.({distanceFromStart}),
    );
  } else {
    ctx.startEdgeStateRef.current.isReached = false;
  }
  };
}
