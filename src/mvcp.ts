export const MVCP_ANCHOR_BASE = 10_000_000;

export function computeExecutableMvcpDelta(
  currentOffset: number,
  diff: number,
  maxScrollOffset: number,
): number {
  if (currentOffset <= 0) return 0;
  const max = Math.max(0, maxScrollOffset);
  const target = Math.min(Math.max(0, currentOffset + diff), max);
  return target - currentOffset;
}
