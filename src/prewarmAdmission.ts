
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
