import {afterEach, describe, expect, it} from '@jest/globals';

import {
  clearMeasurementCache,
  getCachedMean,
  measurementCacheKey,
  recordMeasurement,
} from '../measurementCache';

afterEach(() => {
  clearMeasurementCache();
});

describe('measurementCacheKey', () => {
  it('buckets width to 10dp so sub-bucket resizes share an entry', () => {
    expect(measurementCacheKey('row', 393, 1)).toBe(measurementCacheKey('row', 390, 1));
    expect(measurementCacheKey('row', 393, 1)).not.toBe(measurementCacheKey('row', 411, 1));
  });

  it('separates type, width bucket and font scale', () => {
    const base = measurementCacheKey('row', 390, 1);
    expect(measurementCacheKey('header', 390, 1)).not.toBe(base);
    expect(measurementCacheKey('row', 490, 1)).not.toBe(base);
    expect(measurementCacheKey('row', 390, 1.3)).not.toBe(base);
  });
});

describe('recordMeasurement / getCachedMean', () => {
  it('keeps a running mean per key', () => {
    const key = measurementCacheKey('row', 390, 1);
    expect(getCachedMean(key)).toBeNull();
    recordMeasurement(key, 40);
    recordMeasurement(key, 60);
    expect(getCachedMean(key)).toBe(50);
  });

  it('rejects zero/negative/NaN sizes as conditional-render artifacts', () => {
    const key = measurementCacheKey('row', 390, 1);
    recordMeasurement(key, 0);
    recordMeasurement(key, -5);
    recordMeasurement(key, Number.NaN);
    expect(getCachedMean(key)).toBeNull();
  });

  it('evicts the oldest entry when the cap is reached', () => {
    const first = measurementCacheKey('t0', 390, 1);
    recordMeasurement(first, 10);
    for (let i = 1; i < 512; i++) {
      recordMeasurement(measurementCacheKey(`t${i}`, 390, 1), 10);
    }
    expect(getCachedMean(first)).toBe(10); // at capacity, nothing evicted yet
    recordMeasurement(measurementCacheKey('overflow', 390, 1), 10);
    expect(getCachedMean(first)).toBeNull(); // FIFO eviction hit the oldest
    expect(getCachedMean(measurementCacheKey('overflow', 390, 1))).toBe(10);
  });

  it('stops refining after the per-key sample cap instead of freezing wrongly early', () => {
    const key = measurementCacheKey('row', 390, 1);
    for (let i = 0; i < 64; i++) recordMeasurement(key, 100);
    const frozen = getCachedMean(key);
    recordMeasurement(key, 900); // past the cap — must not move the mean
    expect(getCachedMean(key)).toBe(frozen);
  });
});
