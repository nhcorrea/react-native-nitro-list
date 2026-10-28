
export interface AdmissionRange {
  start: number;
  end: number;
}

export const PREWARM_ADMISSION_BUDGET_ITEMS = 16;

export function rangeCovers(outer: AdmissionRange, inner: AdmissionRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

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

export function idleReserveRange(
  live: AdmissionRange,
  itemCount: number,
  span: number,
  readItemOffset: (index: number) => number,
  indexAtOffset: (offset: number) => number,
): {range: AdmissionRange; direction: 1 | -1} | null {
  if (itemCount <= 0 || live.end < live.start || span <= 0) return null;
  if (live.end < itemCount - 1) {
    const start = live.end + 1;
    return {range: {start, end: Math.min(itemCount - 1, Math.max(start, indexAtOffset(readItemOffset(start) + span)))}, direction: 1};
  }
  if (live.start <= 0) return null;
  const end = live.start - 1;
  return {range: {start: Math.min(end, Math.max(0, indexAtOffset(Math.max(0, readItemOffset(end) - span)))), end}, direction: -1};
}

export function gestureSliceBudget(sliceBudget: number, freeCells: number, liveEdgeCells: number): number {
  return Math.max(0, Math.min(sliceBudget, freeCells - liveEdgeCells));
}

export interface IdleReserveState {
  timer: ReturnType<typeof setTimeout> | null;
  admission: {cancelAck: (() => void) | null} | null;
}

export function deferIdleReserveForScroll(
  state: IdleReserveState,
  clearTimer: () => void,
  clearRange: () => void,
  reschedule: () => void,
): void {
  if (state.timer == null && state.admission == null) return;
  clearTimer();
  const admission = state.admission;
  state.admission = null;
  if (admission != null) {
    admission.cancelAck?.();
    clearRange();
  }
  reschedule();
}
