
interface CacheStats {
  mean: number;
  num: number;
  m2: number;
  variable: boolean;
}

const MAX_ENTRIES = 512;
const MAX_SAMPLES_PER_KEY = 64;
const WIDTH_BUCKET_DP = 10;

export const AUTO_FIXED_MIN_SAMPLES = 32;
export const AUTO_FIXED_MAX_VARIANCE = 0.1;

const cache = new Map<string, CacheStats>();

export function measurementCacheKey(
  type: string | number,
  widthDp: number,
  fontScale: number,
): string {
  return `${type}|${Math.round(widthDp / WIDTH_BUCKET_DP)}|${fontScale}`;
}

function pushSample(entry: CacheStats, sizeDp: number): void {
  entry.num++;
  const delta = sizeDp - entry.mean;
  entry.mean += delta / entry.num;
  entry.m2 += delta * (sizeDp - entry.mean);
}

export function recordMeasurement(key: string, sizeDp: number): void {
  if (!(sizeDp > 0)) return;
  const entry = cache.get(key);
  if (entry == null) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, {mean: sizeDp, num: 1, m2: 0, variable: false});
    return;
  }
  if (entry.num < MAX_SAMPLES_PER_KEY) {
    pushSample(entry, sizeDp);
  }
}

export function getCachedMean(key: string): number | null {
  return cache.get(key)?.mean ?? null;
}

export function getCachedFixedSize(key: string): number | null {
  const entry = cache.get(key);
  if (entry == null || entry.variable || entry.num < AUTO_FIXED_MIN_SAMPLES) return null;
  return entry.m2 / entry.num <= AUTO_FIXED_MAX_VARIANCE ? entry.mean : null;
}

export function markMeasurementVariable(key: string, sizeDp: number): void {
  const entry = cache.get(key);
  if (entry == null) {
    if (sizeDp > 0) {
      cache.set(key, {mean: sizeDp, num: 1, m2: 0, variable: true});
    }
    return;
  }
  if (sizeDp > 0) pushSample(entry, sizeDp);
  entry.variable = true;
}

export function clearMeasurementCache(): void {
  cache.clear();
}
