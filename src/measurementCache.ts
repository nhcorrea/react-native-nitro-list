
interface CacheStats {
  mean: number;
  num: number;
  m2: number;
  variable: boolean;
}

const MAX_ENTRIES = 512;
const MAX_SAMPLES_PER_KEY = 64;
const DEFAULT_DOMAIN = {};
const domains = new WeakMap<object, number>();
let nextDomain = 0;

export const AUTO_FIXED_MIN_SAMPLES = 32;
export const AUTO_FIXED_MAX_VARIANCE = 0.1;

const cache = new Map<string, CacheStats>();

export function measurementCacheKey(
  type: string | number,
  widthDp: number,
  fontScale: number,
  domain: object = DEFAULT_DOMAIN,
): string {
  let id = domains.get(domain);
  if (id == null) {
    id = ++nextDomain;
    domains.set(domain, id);
  }
  return JSON.stringify([id, typeof type, type, widthDp, fontScale]);
}

function pushSample(entry: CacheStats, sizeDp: number): void {
  if (entry.num === MAX_SAMPLES_PER_KEY) {
    // Bounded effective weight with continued learning after sample 64.
    const delta = sizeDp - entry.mean;
    entry.mean += delta / MAX_SAMPLES_PER_KEY;
    entry.m2 = (1 - 1 / MAX_SAMPLES_PER_KEY) * (entry.m2 + delta * delta);
    return;
  }
  entry.num++;
  const delta = sizeDp - entry.mean;
  entry.mean += delta / entry.num;
  entry.m2 += delta * (sizeDp - entry.mean);
}

export function recordMeasurement(key: string, sizeDp: number): void {
  if (!(sizeDp > 0) || !Number.isFinite(sizeDp)) return;
  const entry = cache.get(key);
  if (entry == null) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, {mean: sizeDp, num: 1, m2: 0, variable: false});
    return;
  }
  pushSample(entry, sizeDp);
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
    recordMeasurement(key, sizeDp);
    const created = cache.get(key);
    if (created != null) created.variable = true;
    return;
  }
  if (sizeDp > 0 && Number.isFinite(sizeDp)) pushSample(entry, sizeDp);
  entry.variable = true;
}

export function clearMeasurementCache(): void {
  cache.clear();
}
