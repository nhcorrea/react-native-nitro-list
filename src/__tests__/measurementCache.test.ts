import {afterEach, describe, expect, it} from '@jest/globals';

import {
  AUTO_FIXED_MIN_SAMPLES,
  clearMeasurementCache,
  getCachedFixedSize,
  getCachedMean,
  markMeasurementVariable,
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
    expect(getCachedMean(first)).toBe(10);
    recordMeasurement(measurementCacheKey('overflow', 390, 1), 10);
    expect(getCachedMean(first)).toBeNull();
    expect(getCachedMean(measurementCacheKey('overflow', 390, 1))).toBe(10);
  });

  it('stops refining after the per-key sample cap instead of freezing wrongly early', () => {
    const key = measurementCacheKey('row', 390, 1);
    for (let i = 0; i < 64; i++) recordMeasurement(key, 100);
    const frozen = getCachedMean(key);
    recordMeasurement(key, 900);
    expect(getCachedMean(key)).toBe(frozen);
  });
});

describe('getCachedFixedSize (auto-fixed types)', () => {
  const key = measurementCacheKey('row', 390, 1);

  it('stays null below the sample floor even with zero variance', () => {
    for (let i = 0; i < AUTO_FIXED_MIN_SAMPLES - 1; i++) recordMeasurement(key, 64);
    expect(getCachedFixedSize(key)).toBeNull();
    recordMeasurement(key, 64);
    expect(getCachedFixedSize(key)).toBe(64);
  });

  it('tolerates sub-pixel jitter but not real height variation', () => {
    for (let i = 0; i < AUTO_FIXED_MIN_SAMPLES; i++) recordMeasurement(key, i % 2 === 0 ? 64 : 64.33);
    expect(getCachedFixedSize(key)).toBeCloseTo(64.165, 2);

    const noisy = measurementCacheKey('noisy', 390, 1);
    for (let i = 0; i < AUTO_FIXED_MIN_SAMPLES; i++) recordMeasurement(noisy, i % 2 === 0 ? 40 : 200);
    expect(getCachedMean(noisy)).toBe(120);
    expect(getCachedFixedSize(noisy)).toBeNull();
  });

  it('keeps the running mean exact under the Welford update', () => {
    recordMeasurement(key, 40);
    recordMeasurement(key, 60);
    recordMeasurement(key, 50);
    expect(getCachedMean(key)).toBe(50);
  });

  it('markMeasurementVariable poisons the key past the sample cap', () => {
    for (let i = 0; i < 64; i++) recordMeasurement(key, 64);
    expect(getCachedFixedSize(key)).toBe(64);
    markMeasurementVariable(key, 90);
    expect(getCachedFixedSize(key)).toBeNull();
    for (let i = 0; i < 10; i++) recordMeasurement(key, 64);
    expect(getCachedFixedSize(key)).toBeNull();
    expect(getCachedMean(key)).not.toBeNull();
  });

  it('markMeasurementVariable on an unknown key records the sample as variable', () => {
    const fresh = measurementCacheKey('fresh', 390, 1);
    markMeasurementVariable(fresh, 72);
    expect(getCachedMean(fresh)).toBe(72);
    for (let i = 0; i < AUTO_FIXED_MIN_SAMPLES; i++) recordMeasurement(fresh, 72);
    expect(getCachedFixedSize(fresh)).toBeNull();
  });
});
