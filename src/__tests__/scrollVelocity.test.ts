import {describe, expect, it} from '@jest/globals';

import {
  createVelocityRing,
  estimateDirectionalVelocity,
  pushVelocitySample,
  resetVelocityRing,
  VELOCITY_RING_CAPACITY,
} from '../scrollVelocity';

describe('estimateDirectionalVelocity', () => {
  it('recovers a constant velocity exactly', () => {
    const ring = createVelocityRing();
    for (let i = 0; i <= 4; i++) {
      pushVelocitySample(ring, i * 32, 1000 + i * 16);
    }
    expect(estimateDirectionalVelocity(ring, 1064)).toBeCloseTo(2000);
  });

  it('needs at least two samples', () => {
    const ring = createVelocityRing();
    expect(estimateDirectionalVelocity(ring, 1000)).toBe(0);
    pushVelocitySample(ring, 100, 1000);
    expect(estimateDirectionalVelocity(ring, 1000)).toBe(0);
  });

  it('weights recent segments more than old ones', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 0, 1000);
    pushVelocitySample(ring, 100, 1100);
    pushVelocitySample(ring, 300, 1200);
    const estimate = estimateDirectionalVelocity(ring, 1200);
    expect(estimate).toBeGreaterThan(1500);
    expect(estimate).toBeLessThan(2000);
  });

  it('cuts at the first direction inversion', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 500, 1000);
    pushVelocitySample(ring, 400, 1050);
    pushVelocitySample(ring, 450, 1100);
    pushVelocitySample(ring, 500, 1150);
    const estimate = estimateDirectionalVelocity(ring, 1150);
    expect(estimate).toBeCloseTo(1000);
  });

  it('ignores same-tick duplicate samples instead of dividing by zero', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 0, 1000);
    pushVelocitySample(ring, 50, 1050);
    pushVelocitySample(ring, 50, 1050);
    expect(estimateDirectionalVelocity(ring, 1050)).toBeCloseTo(1000);
  });

  it('treats a stale gap as a new gesture', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 0, 1000);
    pushVelocitySample(ring, 1000, 1016);
    pushVelocitySample(ring, 1000, 2000);
    pushVelocitySample(ring, 1050, 2016);
    expect(estimateDirectionalVelocity(ring, 2016)).toBeCloseTo(3125);
  });

  it('returns zero when every sample is stale relative to now', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 0, 1000);
    pushVelocitySample(ring, 100, 1016);
    expect(estimateDirectionalVelocity(ring, 2000)).toBe(0);
  });

  it('keeps only the newest capacity samples', () => {
    const ring = createVelocityRing();
    for (let i = 0; i < VELOCITY_RING_CAPACITY + 3; i++) {
      pushVelocitySample(ring, i * 10, 1000 + i * 16);
    }
    expect(ring.count).toBe(VELOCITY_RING_CAPACITY);
    const estimate = estimateDirectionalVelocity(ring, 1000 + (VELOCITY_RING_CAPACITY + 2) * 16);
    expect(estimate).toBeCloseTo(625);
  });

  it('reset clears history', () => {
    const ring = createVelocityRing();
    pushVelocitySample(ring, 0, 1000);
    pushVelocitySample(ring, 100, 1050);
    resetVelocityRing(ring);
    expect(estimateDirectionalVelocity(ring, 1050)).toBe(0);
  });
});
