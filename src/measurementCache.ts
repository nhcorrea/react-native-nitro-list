
interface CacheStats {
  mean: number;
  num: number;
}

const MAX_ENTRIES = 512;
const MAX_SAMPLES_PER_KEY = 64;
const WIDTH_BUCKET_DP = 10;

const cache = new Map<string, CacheStats>();

export function measurementCacheKey(
  type: string | number,
  widthDp: number,
  fontScale: number,
): string {
  return `${type}|${Math.round(widthDp / WIDTH_BUCKET_DP)}|${fontScale}`;
}

export function recordMeasurement(key: string, sizeDp: number): void {
  if (!(sizeDp > 0)) return;
  const entry = cache.get(key);
  if (entry == null) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, {mean: sizeDp, num: 1});
    return;
  }
  if (entry.num < MAX_SAMPLES_PER_KEY) {
    entry.mean = (entry.mean * entry.num + sizeDp) / (entry.num + 1);
    entry.num++;
  }
}

export function getCachedMean(key: string): number | null {
  return cache.get(key)?.mean ?? null;
}

export function clearMeasurementCache(): void {
  cache.clear();
}
