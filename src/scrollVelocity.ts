export const VELOCITY_RING_CAPACITY = 5;
export const VELOCITY_EWMA_TAU_MS = 200;
export const VELOCITY_STALE_MS = 200;

export type VelocityRing = {
  offsets: Float64Array;
  times: Float64Array;
  count: number;
  next: number;
};

export function createVelocityRing(): VelocityRing {
  return {
    offsets: new Float64Array(VELOCITY_RING_CAPACITY),
    times: new Float64Array(VELOCITY_RING_CAPACITY),
    count: 0,
    next: 0,
  };
}

export function resetVelocityRing(ring: VelocityRing): void {
  ring.count = 0;
  ring.next = 0;
}

export function pushVelocitySample(ring: VelocityRing, offset: number, timeMs: number): void {
  if (ring.count > 0) {
    const newest = (ring.next - 1 + VELOCITY_RING_CAPACITY) % VELOCITY_RING_CAPACITY;
    if (timeMs - ring.times[newest] > VELOCITY_STALE_MS) {
      resetVelocityRing(ring);
    }
  }
  ring.offsets[ring.next] = offset;
  ring.times[ring.next] = timeMs;
  ring.next = (ring.next + 1) % VELOCITY_RING_CAPACITY;
  if (ring.count < VELOCITY_RING_CAPACITY) ring.count++;
}

export function estimateDirectionalVelocity(ring: VelocityRing, nowMs: number): number {
  if (ring.count < 2) return 0;
  let weightedSum = 0;
  let weightSum = 0;
  let direction = 0;
  for (let k = 0; k < ring.count - 1; k++) {
    const newer = (ring.next - 1 - k + 2 * VELOCITY_RING_CAPACITY) % VELOCITY_RING_CAPACITY;
    const older = (newer - 1 + VELOCITY_RING_CAPACITY) % VELOCITY_RING_CAPACITY;
    const segmentEnd = ring.times[newer];
    if (nowMs - segmentEnd > VELOCITY_STALE_MS) break;
    const dt = segmentEnd - ring.times[older];
    if (dt > VELOCITY_STALE_MS) break;
    if (dt <= 0) continue;
    const slope = ((ring.offsets[newer] - ring.offsets[older]) / dt) * 1000;
    if (slope !== 0) {
      const slopeDirection = slope > 0 ? 1 : -1;
      if (direction === 0) {
        direction = slopeDirection;
      } else if (slopeDirection !== direction) {
        break;
      }
    }
    const weight = Math.exp(-(nowMs - segmentEnd) / VELOCITY_EWMA_TAU_MS);
    weightedSum += slope * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 0;
}
