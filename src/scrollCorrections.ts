export type PendingScrollCorrection = {
  delta: number;
  sequence: number;
  appliedAt: number;
  createdAt: number;
};

export const SCROLL_CORRECTION_ECHO_MAX_AGE_MS = 1000;

export function pendingCorrectionShift(
  pending: PendingScrollCorrection[],
  eventTimestamp: number | undefined,
  nowMs: number,
  mountedAt: (sequence: number) => number,
  maxAgeMs: number = SCROLL_CORRECTION_ECHO_MAX_AGE_MS,
): number {
  if (pending.length === 0) return 0;
  let shift = 0;
  let kept = 0;
  for (const entry of pending) {
    if (entry.appliedAt < 0) entry.appliedAt = mountedAt(entry.sequence);
    const applied = entry.appliedAt >= 0;
    if (applied && (eventTimestamp == null || eventTimestamp >= entry.appliedAt)) continue;
    if (!applied && nowMs - entry.createdAt > maxAgeMs) continue;
    shift += entry.delta;
    pending[kept++] = entry;
  }
  pending.length = kept;
  return shift;
}

export function scrollEventTimestamp(nativeEvent: object): number | undefined {
  const timestamp = (nativeEvent as {timestamp?: unknown}).timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}
