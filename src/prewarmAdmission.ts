/**
 * Budgeted admission for the fling-destination prewarm (the HiPR idea: after
 * a change, update what matters perceptually first and let the rest arrive
 * in later frames).
 *
 * Priority mapping for NitroList's mount work:
 * - P0–P2 (visible, incoming, overscan): the live native range. Always mounts
 *   in full — never budgeted.
 * - P3 (speculative fling-destination prewarm): admitted through THIS module,
 *   up to a per-frame item budget, landing-viewport first, expanding toward
 *   the full window across subsequent frames.
 * - The scrollToIndex prewarm is NOT budgeted: its cells must mount to be
 *   measured for the convergence passes — slicing it would add frames to
 *   every scrollToIndex.
 *
 * Degradation is inherent: cells not yet admitted simply keep estimate-based
 * layout until their frame comes — the fling has 300–1500ms of deceleration
 * to absorb that, instead of one tick absorbing an 80-item mount burst.
 */

export interface AdmissionRange {
  start: number;
  end: number;
}

/**
 * Items admitted per frame. Provisional: calibrate against `mountBurst p95`
 * (régua v3) on physical devices — the budget should sit where one frame's
 * mounts stop showing up in the jsTick tail. 16 covers a typical landing
 * viewport in one slice and an 80-item window in 5 frames (~83ms at 60fps),
 * well inside the deceleration window.
 */
export const PREWARM_ADMISSION_BUDGET_ITEMS = 16;

export function rangeCovers(outer: AdmissionRange, inner: AdmissionRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * Grows `admitted` by up to `budget` items toward covering `target`.
 *
 * First call (admitted == null) seats the focus window (the strictly-visible
 * landing zone) — trimmed to the budget's leading edge if it alone exceeds
 * the budget. Later calls extend outward, scroll-direction side first, so the
 * content about to enter the viewport wins ties against content behind it.
 *
 * Pure and single-stepped so the caller owns pacing (one call per frame) and
 * cancellation; `direction` is the fling's sign (+1 scrolling down).
 */
export function growAdmittedRange(
  target: AdmissionRange,
  focus: AdmissionRange,
  admitted: AdmissionRange | null,
  budget: number,
  direction: 1 | -1,
): AdmissionRange {
  const effectiveBudget = Math.max(1, budget);
  let start: number;
  let end: number;
  let rest: number;

  if (admitted == null) {
    // Clamp focus into target; a disjoint focus (estimates shifted between
    // prediction and admission) falls back to target's leading edge.
    let fStart = Math.max(focus.start, target.start);
    let fEnd = Math.min(focus.end, target.end);
    if (fEnd < fStart) {
      if (direction >= 0) {
        fStart = fEnd = target.start;
      } else {
        fStart = fEnd = target.end;
      }
    }
    const focusLen = fEnd - fStart + 1;
    if (focusLen >= effectiveBudget) {
      return direction >= 0
        ? {start: fStart, end: fStart + effectiveBudget - 1}
        : {start: fEnd - effectiveBudget + 1, end: fEnd};
    }
    start = fStart;
    end = fEnd;
    rest = effectiveBudget - focusLen;
  } else {
    start = admitted.start;
    end = admitted.end;
    rest = effectiveBudget;
  }

  const extendDown = () => {
    const take = Math.min(target.end - end, rest);
    if (take > 0) {
      end += take;
      rest -= take;
    }
  };
  const extendUp = () => {
    const take = Math.min(start - target.start, rest);
    if (take > 0) {
      start -= take;
      rest -= take;
    }
  };
  if (direction >= 0) {
    extendDown();
    extendUp();
  } else {
    extendUp();
    extendDown();
  }
  return {start, end};
}
