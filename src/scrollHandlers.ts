import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';

import {NitroListDevFlags} from './devFlags';
import {MVCP_POSITION_EPSILON} from './measurement';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import {
  classifyScrollEcho,
  classifyScrollEvent,
  type NitroListScrollCommandEcho,
} from './scrollEvents';
import {
  estimateDirectionalVelocity,
  pushVelocitySample,
  resetVelocityRing,
  type VelocityRing,
} from './scrollVelocity';

export const SCROLL_ECHO_EPSILON_DP = 0.5;
export const SCROLL_COMMAND_ECHO_MAX_AGE_MS = 250;
export const FLING_MIN_VELOCITY_DP_S = 1500;

type Ref<V> = {current: V};
type SharedValue<V> = {value: V};
type RangeState = {start: number; end: number; layoutVersion: number};

export interface ScrollHandlersCtx {
  userOnScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollOffsetSharedValue?: SharedValue<number> | null;
  uiScrollOffsetSv: SharedValue<number>;
  applyMvcpCorrectionRef: Ref<(diff: number) => void>;
  captureMvcpAnchorRef: Ref<(engineOffset: number) => void>;
  checkEdgeCallbacksRef: Ref<() => void>;
  crossViewportRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  emitFirstVisibleRef: Ref<() => void>;
  evaluateViewabilityRef: Ref<() => void>;
  hasInteractedRef: Ref<boolean>;
  isHorizontalRef: Ref<boolean>;
  isPrewarmingRangeRef: Ref<boolean>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  lastPushedEngineOffsetRef: Ref<number | null>;
  lastScrollOffsetRef: Ref<number>;
  lastViewabilityEvalRef: Ref<{offset: number}>;
  latestRangeRef: Ref<{start: number; end: number}>;
  mainViewportRef: Ref<number>;
  mvcpStateRef: Ref<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>;
  pendingScrollCommandRef: Ref<NitroListScrollCommandEcho | null>;
  pendingSizesRef: Ref<{count: number}>;
  prewarmFlingDestinationRef: Ref<() => void>;
  programmaticAnimatedScrollSeenRef: Ref<boolean>;
  recordFlingOutcomeRef: Ref<(finalAbsoluteY: number) => void>;
  scrollActivityRef: Ref<{
    dragging: boolean;
    momentum: boolean;
    programmaticAnimated: boolean;
    pendingAdjust: number;
  }>;
  scrollVelocityRef: Ref<{offset: number; time: number; velocity: number}>;
  suppressEdgeRearmRef: Ref<boolean>;
  uiThreadDriverActiveRef: Ref<boolean>;
  updateAlignPadRef: Ref<() => void>;
  updateEndSpaceRef: Ref<() => void>;
  velocityRingRef: Ref<VelocityRing>;
  viewportSizeRef: Ref<{width: number; height: number}>;
  mountTimestampRef: Ref<number>;
  applyScrollOffsetSync: (engineOffset: number) => void;
  beginScrollCommand: () => number;
  cancelFlingPrewarm: () => void;
  cancelPendingStickToEnd: () => void;
  captureMvcpAnchor: (engineOffset: number) => void;
  endProgrammaticAnimatedScroll: () => void;
  flushDeferredLiveRange: () => void;
  flushPendingItemSizes: (emitRange?: boolean) => void;
  getMaxScrollOffset: () => number;
  noteVelocityForAdaptive: (velocityDpS: number) => void;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  readTotalSize: () => number;
  resetScrollVelocity: () => void;
  seedTypeMeansFromCache: () => void;
  setPrewarmRangeTracked: (next: RangeState | null) => void;
  setEngineViewport: (width: number, height: number) => void;
  updateSticky: (offset: number) => void;
  userOnScrollRef: Ref<
    ((e: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined
  >;
}

export interface ScrollHandlersApi {
  settleScrollPosition: (target: number, engineOffset: number) => void;
  settleProgrammaticAnimatedScroll: (target: number) => void;
  flushPendingMvcpAdjust: () => void;
  handleOuterScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleOuterLayout: (e: LayoutChangeEvent) => void;
  handleScrollBeginDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleMomentumScrollBegin: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  settleUiViewabilityTick: (absoluteY: number) => void;
  settleUiEndDrag: (velocityDpS: number, absoluteY: number) => void;
  emitUserScrollFromUi: (y: number) => void;
}

export function createScrollHandlers(ctx: ScrollHandlersCtx): ScrollHandlersApi {
  const settleScrollPosition = (target: number, engineOffset: number): void => {
    ctx.lastScrollOffsetRef.current = target;
    ctx.uiScrollOffsetSv.value = engineOffset;
    ctx.applyScrollOffsetSync(engineOffset);
    ctx.flushDeferredLiveRange();
    ctx.updateSticky(engineOffset);
    ctx.evaluateViewabilityRef.current();
    ctx.checkEdgeCallbacksRef.current();
    ctx.captureMvcpAnchorRef.current(engineOffset);
  };

  const settleProgrammaticAnimatedScroll = (target: number): void => {
    ctx.resetScrollVelocity();
    settleScrollPosition(target, target - ctx.effectivePaddingStartRef.current);
  };

  const flushPendingMvcpAdjust = (): void => {
  const activity = ctx.scrollActivityRef.current;
  const pending = activity.pendingAdjust;
  if (pending === 0) return;
  activity.pendingAdjust = 0;
  if (Math.abs(pending) > MVCP_POSITION_EPSILON) {
    const anchor = ctx.mvcpStateRef.current.anchor;
    if (anchor != null) anchor.offset -= pending;
    ctx.applyMvcpCorrectionRef.current(pending);
  }
  };

  const handleOuterScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    let scrollY = ctx.isHorizontalRef.current
      ? e.nativeEvent.contentOffset.x
      : e.nativeEvent.contentOffset.y;
    const nowMs = Date.now();
    if (NitroListDevFlags.scrollEchoGuard) {
      const command = ctx.pendingScrollCommandRef.current;
      const echo = classifyScrollEcho(
        scrollY,
        command,
        nowMs,
        SCROLL_ECHO_EPSILON_DP,
        SCROLL_COMMAND_ECHO_MAX_AGE_MS,
      );
      if (echo === 'stale' && command != null) {
        command.staleOffset = scrollY;
        scrollY = command.target;
      } else if (echo === 'resolved') {
        ctx.pendingScrollCommandRef.current = null;
      }
    }
    if (!ctx.uiThreadDriverActiveRef.current && ctx.pendingSizesRef.current.count > 0) {
      ctx.flushPendingItemSizes(false);
    }
    const kind = classifyScrollEvent(
      scrollY,
      ctx.lastScrollOffsetRef.current,
      ctx.mainViewportRef.current,
      ctx.scrollActivityRef.current.programmaticAnimated,
    );
    if (kind === 'programmatic') {
      ctx.programmaticAnimatedScrollSeenRef.current = true;
    }
    if (ctx.isPrewarmingRangeRef.current) {
      ctx.isPrewarmingRangeRef.current = false;
      ctx.lastPrewarmRangeRef.current = null;
      ctx.setPrewarmRangeTracked(null);
    }
    const velocitySample = ctx.scrollVelocityRef.current;
    if (kind === 'large-jump') {
      velocitySample.velocity = 0;
      resetVelocityRing(ctx.velocityRingRef.current);
      ctx.cancelFlingPrewarm();
      ctx.suppressEdgeRearmRef.current = true;
    } else {
      const dtMs = nowMs - velocitySample.time;
      if (dtMs > 200) {
        velocitySample.velocity = 0;
      } else if (dtMs >= 1) {
        velocitySample.velocity = ((scrollY - velocitySample.offset) / dtMs) * 1000;
      }
      pushVelocitySample(ctx.velocityRingRef.current, scrollY, nowMs);
    }
    velocitySample.offset = scrollY;
    velocitySample.time = nowMs;
    ctx.noteVelocityForAdaptive(velocitySample.velocity);
    ctx.lastScrollOffsetRef.current = scrollY;
    if (ctx.scrollOffsetSharedValue != null) {
      ctx.scrollOffsetSharedValue.value = scrollY;
    }
    const engineOffset = scrollY - ctx.effectivePaddingStartRef.current;
    if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
      NitroListPerfMonitor.markScrollDispatch();
    }
    if (!ctx.uiThreadDriverActiveRef.current) {
      const pushed = ctx.lastPushedEngineOffsetRef.current;
      if (
        NitroListDevFlags.scrollEchoGuard &&
        pushed != null &&
        Math.abs(engineOffset - pushed) <= SCROLL_ECHO_EPSILON_DP
      ) {
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.clearScrollDispatchMark();
      } else {
        ctx.applyScrollOffsetSync(engineOffset);
      }
    }
    ctx.updateSticky(engineOffset);
    ctx.evaluateViewabilityRef.current();
    ctx.checkEdgeCallbacksRef.current();
    ctx.captureMvcpAnchor(engineOffset);
    ctx.emitFirstVisibleRef.current();
    if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
      const viewportH = ctx.mainViewportRef.current;
      if (viewportH > 0) {
        const visTop = Math.max(0, engineOffset);
        const visBottom = Math.min(engineOffset + viewportH, ctx.readTotalSize());
        if (visBottom > visTop) {
          const r = ctx.latestRangeRef.current;
          let blankPx: number;
          if (r.end < r.start) {
            blankPx = visBottom - visTop;
          } else {
            const coveredTop = ctx.readItemOffset(r.start);
            const coveredBottom = ctx.readItemOffset(r.end) + ctx.readItemSize(r.end);
            blankPx =
              Math.max(0, coveredTop - visTop) + Math.max(0, visBottom - coveredBottom);
          }
          NitroListPerfMonitor.recordScrollSample(blankPx);
        }
      }
    }
    ctx.userOnScroll?.(e);
  };

  const handleOuterLayout = (e: LayoutChangeEvent): void => {
    const {width, height} = e.nativeEvent.layout;
    ctx.viewportSizeRef.current = {width, height};
    ctx.mainViewportRef.current = ctx.isHorizontalRef.current ? width : height;
    ctx.crossViewportRef.current = ctx.isHorizontalRef.current ? height : width;
    ctx.setEngineViewport(width, height);
    ctx.seedTypeMeansFromCache();
    ctx.updateAlignPadRef.current();
    ctx.updateEndSpaceRef.current();
    ctx.updateSticky(ctx.lastScrollOffsetRef.current - ctx.effectivePaddingStartRef.current);
    ctx.evaluateViewabilityRef.current();
    ctx.checkEdgeCallbacksRef.current();
    ctx.emitFirstVisibleRef.current();
  };

  const handleScrollBeginDrag = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    ctx.endProgrammaticAnimatedScroll();
    ctx.pendingScrollCommandRef.current = null;
    ctx.flushDeferredLiveRange();
    flushPendingMvcpAdjust();
    ctx.beginScrollCommand();
    ctx.cancelPendingStickToEnd();
    const activity = ctx.scrollActivityRef.current;
    activity.dragging = true;
    activity.momentum = false;
    ctx.cancelFlingPrewarm();
    if (ctx.uiThreadDriverActiveRef.current && ctx.isPrewarmingRangeRef.current) {
      ctx.isPrewarmingRangeRef.current = false;
      ctx.lastPrewarmRangeRef.current = null;
    }
    if (!ctx.isPrewarmingRangeRef.current) {
      ctx.setPrewarmRangeTracked(null);
    }
    if (!ctx.hasInteractedRef.current) {
      ctx.hasInteractedRef.current = true;
      ctx.lastViewabilityEvalRef.current.offset = Number.NaN;
      ctx.evaluateViewabilityRef.current();
    }
    ctx.onScrollBeginDrag?.(e);
  };

  const handleScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const activity = ctx.scrollActivityRef.current;
    activity.dragging = false;
    if (ctx.uiThreadDriverActiveRef.current) {
      ctx.lastScrollOffsetRef.current = ctx.isHorizontalRef.current
        ? e.nativeEvent.contentOffset.x
        : e.nativeEvent.contentOffset.y;
    } else {
      const launchVelocity = estimateDirectionalVelocity(ctx.velocityRingRef.current, Date.now());
      ctx.scrollVelocityRef.current.velocity = launchVelocity;
      if (Math.abs(launchVelocity) >= FLING_MIN_VELOCITY_DP_S) {
        ctx.prewarmFlingDestinationRef.current();
      } else {
        flushPendingMvcpAdjust();
      }
    }
    ctx.onScrollEndDrag?.(e);
  };

  const handleMomentumScrollBegin = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    ctx.scrollActivityRef.current.momentum = true;
    ctx.onMomentumScrollBegin?.(e);
  };

  const handleMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const activity = ctx.scrollActivityRef.current;
    activity.momentum = false;
    const momentumOffset = ctx.isHorizontalRef.current
      ? e.nativeEvent.contentOffset.x
      : e.nativeEvent.contentOffset.y;
    const settleProgrammatic = activity.programmaticAnimated;
    ctx.endProgrammaticAnimatedScroll();
    if (settleProgrammatic) settleProgrammaticAnimatedScroll(momentumOffset);
    ctx.noteVelocityForAdaptive(0);
    ctx.recordFlingOutcomeRef.current(momentumOffset);
    ctx.cancelFlingPrewarm();
    if (!ctx.isPrewarmingRangeRef.current) {
      ctx.setPrewarmRangeTracked(null);
    }
    const uiDriven = ctx.uiThreadDriverActiveRef.current;
    if (uiDriven) {
      ctx.lastScrollOffsetRef.current = momentumOffset;
    }
    flushPendingMvcpAdjust();
    if (uiDriven) {
      const engineOffset = ctx.lastScrollOffsetRef.current - ctx.effectivePaddingStartRef.current;
      ctx.evaluateViewabilityRef.current();
      ctx.checkEdgeCallbacksRef.current();
      ctx.captureMvcpAnchor(engineOffset);
      ctx.emitFirstVisibleRef.current();
    }
    ctx.onMomentumScrollEnd?.(e);
  };
  const settleUiViewabilityTick = (absoluteY: number): void => {
    ctx.lastScrollOffsetRef.current = absoluteY;
    ctx.evaluateViewabilityRef.current();
  };

  const settleUiEndDrag = (velocityDpS: number, absoluteY: number): void => {
    ctx.lastScrollOffsetRef.current = absoluteY;
    const sample = ctx.scrollVelocityRef.current;
    sample.velocity = velocityDpS;
    sample.offset = absoluteY;
    sample.time = Date.now();
    if (Math.abs(velocityDpS) >= FLING_MIN_VELOCITY_DP_S) {
      ctx.prewarmFlingDestinationRef.current();
    } else {
      flushPendingMvcpAdjust();
    }
  };

  const emitUserScrollFromUi = (y: number): void => {
    ctx.lastScrollOffsetRef.current = y;
    const contentOffset = ctx.isHorizontalRef.current ? {x: y, y: 0} : {x: 0, y};
    ctx.userOnScrollRef.current?.({
      nativeEvent: {contentOffset},
    } as NativeSyntheticEvent<NativeScrollEvent>);
  };

  return {
    settleUiViewabilityTick,
    settleUiEndDrag,
    emitUserScrollFromUi,
    settleScrollPosition,
    settleProgrammaticAnimatedScroll,
    flushPendingMvcpAdjust,
    handleOuterScroll,
    handleOuterLayout,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  };
}
