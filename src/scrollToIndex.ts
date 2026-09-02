import {NitroListDevFlags} from './devFlags';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import {interpolateOffset, waitForLayoutPass} from './scrollCommands';

export const SCROLL_TO_INDEX_STEPS = 1;
export const SCROLL_TO_INDEX_BUFFER_MULTIPLIER = 2;
export const SCROLL_TO_INDEX_MAX_RESTARTS = 3;
export const SCROLL_TO_INDEX_TARGET_EPSILON = 1;
export const SCROLL_TO_INDEX_CORRECTION_PASSES = 3;
export const SCROLL_TO_INDEX_SETTLED_SHIFT_RATIO = 0.5;

export interface ScrollToIndexParams {
  index: number;
  animated?: boolean;
  viewPosition?: number;
  viewOffset?: number;
}

type Ref<V> = {current: V};
type RangeState = {start: number; end: number; layoutVersion: number};

export interface ScrollToIndexCtx {
  itemCount: number;
  footerSize: number;
  paddingEnd: number;
  scrollCommandIdRef: Ref<number>;
  lastScrollOffsetRef: Ref<number>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  isPrewarmingRangeRef: Ref<boolean>;
  prewarmFocusRef: Ref<{focus: {start: number; end: number}; direction: 1 | -1} | null>;
  mainViewportRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  effectiveDrawDistanceRef: Ref<number>;
  lastSeenLayoutVersionRef: Ref<number>;
  endSpaceRef: Ref<number>;
  contentInsetBottomRef: Ref<number>;
  animatedScrollResolverRef: Ref<(() => void) | null>;
  beginScrollCommand: () => number;
  resolveScrollCommand: (commandId: number) => void;
  trackScrollCommand: (commandId: number) => Promise<void>;
  awaitScrollReadiness: (commandId: number) => Promise<void>;
  waitForLayoutSettle: (trace?: string[]) => Promise<void>;
  indexAtOffset: (offset: number) => number;
  clampScrollOffset: (offset: number) => number;
  getMaxScrollOffset: () => number;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  applyScrollOffsetSync: (engineOffset: number) => void;
  resetScrollVelocity: () => void;
  scrollToAbsoluteOffset: (offset: number, animated: boolean) => number;
  setRangeTracked: (next: RangeState) => void;
  setPrewarmRangeTracked: (next: RangeState | null) => void;
  cancelFlingPrewarm: () => void;
  cancelPrewarmAdmission: () => void;
  acquireEstimateFreeze: () => void;
  releaseEstimateFreeze: () => void;
}

export interface ScrollToIndexApi {
  prewarmRenderWindow: (offset: number) => number;
  computeIndexScrollOffset: (
    index: number,
    viewPosition: number,
    viewOffset: number,
  ) => number | null;
  computeStartScrollOffset: (finalOffset: number, lastAbsoluteScrollOffset: number) => number;
  converge: (params: ScrollToIndexParams) => Promise<void>;
  precisely: (params: ScrollToIndexParams) => Promise<void>;
  toEnd: (animated: boolean) => Promise<void>;
}

export function createScrollToIndex(ctx: ScrollToIndexCtx): ScrollToIndexApi {
  const prewarmRenderWindow = (offset: number): number => {
    const target = ctx.clampScrollOffset(offset);
    ctx.resetScrollVelocity();
    ctx.applyScrollOffsetSync(target - ctx.effectivePaddingStartRef.current);
    return target;
  };

  const computeIndexScrollOffset = (
    index: number,
    viewPosition: number,
    viewOffset: number,
  ): number | null => {
    if (index < 0 || index >= ctx.itemCount) return null;
    const top = ctx.readItemOffset(index);
    const itemH = ctx.readItemSize(index);
    const viewportH = ctx.mainViewportRef.current;
    const target =
      ctx.effectivePaddingStartRef.current + top - viewPosition * (viewportH - itemH) + viewOffset;
    return ctx.clampScrollOffset(target);
  };

  const computeStartScrollOffset = (
    finalOffset: number,
    lastAbsoluteScrollOffset: number,
  ): number => {
    const viewportH = ctx.mainViewportRef.current;
    const buffer = viewportH * SCROLL_TO_INDEX_BUFFER_MULTIPLIER;
    if (finalOffset > lastAbsoluteScrollOffset) {
      return ctx.clampScrollOffset(Math.max(finalOffset - buffer, lastAbsoluteScrollOffset));
    }
    return ctx.clampScrollOffset(Math.min(finalOffset + buffer, lastAbsoluteScrollOffset));
  };

  const converge = async ({
    index,
    animated = false,
    viewPosition = 0,
    viewOffset = 0,
  }: ScrollToIndexParams): Promise<void> => {
    if (index < 0 || index >= ctx.itemCount) return;

    const commandId = ctx.beginScrollCommand();
    const devStartedAt = NITRO_LIST_PERF_COMPILED ? Date.now() : 0;
    const devTrace: string[] | undefined = NITRO_LIST_PERF_COMPILED ? [] : undefined;
    const devMark = (label: string) => {
      if (devTrace) devTrace.push(`${label} @${Date.now() - devStartedAt}`);
    };
    let devRestarts = 0;
    let devCorrectionPasses = 0;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordScrollToIndexStart();
    ctx.isPrewarmingRangeRef.current = false;
    ctx.lastPrewarmRangeRef.current = null;
    ctx.cancelFlingPrewarm();
    ctx.setPrewarmRangeTracked(null);

    await ctx.awaitScrollReadiness(commandId);
    if (commandId !== ctx.scrollCommandIdRef.current) return;
    devMark('ready');

    let finalOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
    if (finalOffset == null) return;

    if (animated) {
      const viewportH = ctx.mainViewportRef.current;
      if (viewportH > 0) {
        const destEngineTop = finalOffset - ctx.effectivePaddingStartRef.current;
        const destStart = ctx.indexAtOffset(Math.max(0, destEngineTop));
        const destEnd = Math.max(destStart, ctx.indexAtOffset(destEngineTop + viewportH));
        ctx.setPrewarmRangeTracked({
          start: destStart,
          end: destEnd,
          layoutVersion: ctx.lastSeenLayoutVersionRef.current,
        });
      }
      ctx.scrollToAbsoluteOffset(finalOffset, true);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      ctx.isPrewarmingRangeRef.current = true;
      const setLandingFocus = (targetOffset: number) => {
        const viewportH = ctx.mainViewportRef.current;
        const destEngineTop = targetOffset - ctx.effectivePaddingStartRef.current;
        const focusStart = ctx.indexAtOffset(Math.max(0, destEngineTop));
        const focusEnd = Math.max(focusStart, ctx.indexAtOffset(destEngineTop + viewportH));
        ctx.prewarmFocusRef.current = {
          focus: {start: focusStart, end: focusEnd},
          direction: targetOffset >= ctx.lastScrollOffsetRef.current ? 1 : -1,
        };
      };
      try {
        let startOffset = computeStartScrollOffset(finalOffset, ctx.lastScrollOffsetRef.current);
        let initialTargetOffset = finalOffset;
        let initialStartOffset = startOffset;
        let restarts = 0;

        for (let step = 0; step < SCROLL_TO_INDEX_STEPS; step++) {
          if (commandId !== ctx.scrollCommandIdRef.current) return;

          const nextOffset = interpolateOffset(
            startOffset,
            finalOffset,
            step,
            SCROLL_TO_INDEX_STEPS,
          );
          setLandingFocus(finalOffset);
          prewarmRenderWindow(nextOffset);
          await ctx.waitForLayoutSettle(devTrace);
          if (commandId !== ctx.scrollCommandIdRef.current) return;
          devMark(`step${step}`);

          const newFinalOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
          if (newFinalOffset == null) {
            ctx.setPrewarmRangeTracked(null);
            return;
          }

          const targetMovedOutsideInitialWindow =
            (newFinalOffset < initialTargetOffset && newFinalOffset < initialStartOffset) ||
            (newFinalOffset > initialTargetOffset && newFinalOffset > initialStartOffset);

          finalOffset = newFinalOffset;
          if (targetMovedOutsideInitialWindow && restarts < SCROLL_TO_INDEX_MAX_RESTARTS) {
            restarts++;
            devRestarts++;
            startOffset = computeStartScrollOffset(finalOffset, ctx.lastScrollOffsetRef.current);
            initialTargetOffset = finalOffset;
            initialStartOffset = startOffset;
            step = -1;
          }
        }

        for (let pass = 0; pass < SCROLL_TO_INDEX_CORRECTION_PASSES; pass++) {
          if (commandId !== ctx.scrollCommandIdRef.current) return;
          devCorrectionPasses++;
          setLandingFocus(finalOffset);
          prewarmRenderWindow(finalOffset);
          await ctx.waitForLayoutSettle(devTrace);
          if (commandId !== ctx.scrollCommandIdRef.current) return;
          devMark(`pass${pass}`);

          const correctedOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
          if (correctedOffset == null) {
            ctx.setPrewarmRangeTracked(null);
            return;
          }
          const shift = Math.abs(correctedOffset - finalOffset);
          if (devTrace) devTrace.push(`shift ${Math.round(shift)}`);
          if (shift <= SCROLL_TO_INDEX_TARGET_EPSILON) {
            break;
          }
          finalOffset = correctedOffset;
          if (
            NitroListDevFlags.stiEventDrivenWait &&
            shift <= ctx.effectiveDrawDistanceRef.current * SCROLL_TO_INDEX_SETTLED_SHIFT_RATIO
          ) {
            break;
          }
        }
      } finally {
        if (commandId === ctx.scrollCommandIdRef.current) {
          ctx.isPrewarmingRangeRef.current = false;
          ctx.prewarmFocusRef.current = null;
          ctx.cancelPrewarmAdmission();
        }
      }

      if (commandId !== ctx.scrollCommandIdRef.current) return;
      const promoted = ctx.lastPrewarmRangeRef.current;
      ctx.lastPrewarmRangeRef.current = null;
      if (promoted) {
        ctx.setRangeTracked(promoted);
      }
      ctx.scrollToAbsoluteOffset(finalOffset, false);
      ctx.setPrewarmRangeTracked(null);
      if (NITRO_LIST_PERF_COMPILED) {
        devMark('land');
        NitroListPerfMonitor.recordScrollToIndexComplete({
          durationMs: Date.now() - devStartedAt,
          prewarmRestarts: devRestarts,
          correctionPasses: devCorrectionPasses,
          animated: false,
          phases: devTrace?.join(' · '),
        });
      }
      return;
    }

    for (let pass = 0; pass < SCROLL_TO_INDEX_CORRECTION_PASSES; pass++) {
      if (commandId !== ctx.scrollCommandIdRef.current) return;
      devCorrectionPasses++;
      await waitForLayoutPass();
      if (commandId !== ctx.scrollCommandIdRef.current) return;

      const correctedOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
      if (correctedOffset == null) {
        ctx.setPrewarmRangeTracked(null);
        return;
      }
      if (
        Math.abs(correctedOffset - ctx.lastScrollOffsetRef.current) <=
        SCROLL_TO_INDEX_TARGET_EPSILON
      ) {
        break;
      }
      ctx.scrollToAbsoluteOffset(correctedOffset, false);
    }
    ctx.setPrewarmRangeTracked(null);
    if (NITRO_LIST_PERF_COMPILED) {
      NitroListPerfMonitor.recordScrollToIndexComplete({
        durationMs: Date.now() - devStartedAt,
        prewarmRestarts: devRestarts,
        correctionPasses: devCorrectionPasses,
        animated: true,
      });
    }
  };

  const precisely = async (params: ScrollToIndexParams): Promise<void> => {
    ctx.acquireEstimateFreeze();
    try {
      const idBefore = ctx.scrollCommandIdRef.current;
      const running = converge(params);
      const commandId = ctx.scrollCommandIdRef.current;
      if (commandId === idBefore) {
        await running;
        return;
      }
      await Promise.race([running, ctx.trackScrollCommand(commandId)]);
      ctx.resolveScrollCommand(commandId);
    } finally {
      ctx.releaseEstimateFreeze();
    }
  };

  const toEnd = (animated: boolean): Promise<void> => {
    if (ctx.itemCount === 0) {
      const commandId = ctx.beginScrollCommand();
      ctx.scrollToAbsoluteOffset(ctx.getMaxScrollOffset(), animated);
      const promise = ctx.trackScrollCommand(commandId);
      if (animated) {
        ctx.animatedScrollResolverRef.current = () => ctx.resolveScrollCommand(commandId);
      } else {
        requestAnimationFrame(() => ctx.resolveScrollCommand(commandId));
      }
      return promise;
    }
    return precisely({
      index: ctx.itemCount - 1,
      animated,
      viewPosition: 1,
      viewOffset:
        ctx.footerSize +
        ctx.paddingEnd +
        ctx.endSpaceRef.current +
        ctx.contentInsetBottomRef.current,
    });
  };

  return {
    prewarmRenderWindow,
    computeIndexScrollOffset,
    computeStartScrollOffset,
    converge,
    precisely,
    toEnd,
  };
}
