export interface IndexRange {
  start: number;
  end: number;
}

export const RANGE_EDGE_HYSTERESIS_ITEMS = 2;

export function stabilizeRange(
  next: IndexRange,
  prev: IndexRange,
  direction: number,
  itemCount: number,
  maxRetreat: number = RANGE_EDGE_HYSTERESIS_ITEMS,
): IndexRange {
  if (next.end < next.start || prev.end < prev.start || maxRetreat <= 0) return next;
  let start = next.start;
  let end = next.end;
  if (direction >= 0 && next.end < prev.end && prev.end - next.end <= maxRetreat) {
    end = Math.min(prev.end, itemCount - 1);
  }
  if (direction <= 0 && next.start > prev.start && next.start - prev.start <= maxRetreat) {
    start = Math.max(prev.start, 0);
  }
  if (start === next.start && end === next.end) return next;
  return {start, end};
}
