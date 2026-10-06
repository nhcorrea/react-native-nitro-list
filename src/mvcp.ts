export const MVCP_ANCHOR_BASE = 10_000_000;
export const MVCP_ANCHOR_BASES: ReadonlyArray<number> = [2 ** 17, 2 ** 20, MVCP_ANCHOR_BASE];

export function computeExecutableMvcpDelta(
  currentOffset: number,
  diff: number,
  maxScrollOffset: number,
  startEpsilon = 0,
): number {
  if (currentOffset <= startEpsilon) return 0;
  const max = Math.max(0, maxScrollOffset);
  const target = Math.min(Math.max(0, currentOffset + diff), max);
  return target - currentOffset;
}
