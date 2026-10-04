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

export const RANGE_TRAILING_SLACK_ITEMS = 2;

export function deferTrailingEdge(
  next: IndexRange,
  committed: IndexRange,
  itemCount: number,
  maxSlack: number = RANGE_TRAILING_SLACK_ITEMS,
): IndexRange {
  if (next.end < next.start || committed.end < committed.start) return next;
  if (committed.end > itemCount - 1) return next;
  if (next.start < committed.start || next.end > committed.end) return next;
  if (next.start - committed.start > maxSlack || committed.end - next.end > maxSlack) return next;
  return committed;
}

