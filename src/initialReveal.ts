import {waitForLayoutPass} from './scrollCommands';
import {SCROLL_TO_INDEX_TARGET_EPSILON, type ScrollToIndexParams} from './scrollToIndex';

export const INITIAL_REVEAL_MAX_PASSES = 6;
export const INITIAL_REVEAL_STABLE_PASSES = 2;
export const INITIAL_REVEAL_TIMEOUT_MS = 1500;

type Ref<V> = {current: V};

export interface InitialTarget {
  offset: number;
  index: number | null;
  endAligned: boolean;
  settled: boolean;
}

export interface InitialRevealCtx {
  itemCount: number;
  initialTargetRef: Ref<InitialTarget | null>;
  committedRangeRef: Ref<{start: number; end: number; layoutVersion: number}>;
  scrollCommandIdRef: Ref<number>;
  lastScrollOffsetRef: Ref<number>;
  effectivePaddingStartRef: Ref<number>;
  mainViewportRef: Ref<number>;
  getMaxScrollOffset: () => number;
  computeIndexScrollOffset: (
    index: number,
    viewPosition: number,
    viewOffset: number,
  ) => number | null;
  clampScrollOffset: (offset: number) => number;
  scrollToAbsoluteOffset: (offset: number, animated: boolean) => number;
  scrollToIndexPrecisely: (params: ScrollToIndexParams) => Promise<void>;
  scrollToEndPrecisely: (animated: boolean) => Promise<void>;
  indexAtOffset: (offset: number) => number;
  setRevealPending: (pending: boolean) => void;
}

export interface InitialRevealApi {
  pass: () => {diff: number; visKey: string} | null;
  settle: () => void;
}

export function createInitialReveal(ctx: InitialRevealCtx): InitialRevealApi {
  const pass = (): {diff: number; visKey: string} | null => {
    const initial = ctx.initialTargetRef.current;
    if (initial == null || ctx.itemCount === 0) return null;
    let corrected: number | null;
    if (initial.endAligned) {
      corrected = ctx.getMaxScrollOffset();
    } else if (initial.index != null) {
      corrected = ctx.computeIndexScrollOffset(initial.index, 0, 0);
    } else {
      corrected = ctx.clampScrollOffset(initial.offset);
    }
    if (corrected == null) return null;
    const diff = corrected - ctx.lastScrollOffsetRef.current;
    if (Math.abs(diff) > SCROLL_TO_INDEX_TARGET_EPSILON) {
      ctx.scrollToAbsoluteOffset(corrected, false);
    }
    const engineTop = Math.max(
      0,
      ctx.lastScrollOffsetRef.current - ctx.effectivePaddingStartRef.current,
    );
    const first = ctx.indexAtOffset(engineTop);
    const last = Math.max(first, ctx.indexAtOffset(engineTop + ctx.mainViewportRef.current));
    return {diff: Math.abs(diff), visKey: `${first}:${last}`};
  };

  const settle = (): void => {
    const initial = ctx.initialTargetRef.current;
    if (initial == null || initial.settled) return;
    if (ctx.committedRangeRef.current.end < 0) return;
    if (!initial.endAligned && initial.index != null && initial.index >= ctx.itemCount) return;
    if (initial.endAligned && ctx.itemCount === 0) return;
    initial.settled = true;
    void (async () => {
      try {
        if (initial.endAligned) {
          await ctx.scrollToEndPrecisely(false);
        } else if (initial.index != null) {
          await ctx.scrollToIndexPrecisely({index: initial.index, animated: false});
        } else {
          ctx.scrollToAbsoluteOffset(initial.offset, false);
        }
        const commandToken = ctx.scrollCommandIdRef.current;
        let stablePasses = 0;
        let lastVisKey = '';
        for (
          let step = 0;
          step < INITIAL_REVEAL_MAX_PASSES && stablePasses < INITIAL_REVEAL_STABLE_PASSES;
          step++
        ) {
          if (ctx.scrollCommandIdRef.current !== commandToken) break;
          const result = pass();
          if (result == null) break;
          if (result.diff <= SCROLL_TO_INDEX_TARGET_EPSILON && result.visKey === lastVisKey) {
            stablePasses++;
          } else {
            stablePasses = 0;
          }
          lastVisKey = result.visKey;
          await waitForLayoutPass();
        }
      } finally {
        ctx.setRevealPending(false);
      }
    })();
  };

  return {pass, settle};
}
