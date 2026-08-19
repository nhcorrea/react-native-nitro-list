/**
 * Cross-mount measurement cache — structurally identical work should reuse
 * prior results. Per-type mean cell heights keyed by the context that
 * determines a template's height: type string + width bucket + font scale.
 *
 * Module-level on purpose: the native core's type stats die with the view
 * instance (`resetAll` on unmount/recycle); this map survives within the
 * process, and every mount re-seeds the core from it (`seedTypeMeans`).
 * Seeds are estimates only — the native side never lets them beat real
 * measurements nor mark anything measured.
 *
 * Width/fontScale are part of the key, so rotation, split-screen and system
 * font changes land in a different bucket instead of poisoning the old one.
 */

interface CacheStats {
  mean: number;
  num: number;
}

/**
 * Entry cap. Eviction is insertion-order (oldest first) — a plain Map keeps
 * that order for free and the cache is small enough that precision beyond
 * FIFO is not worth bookkeeping.
 */
const MAX_ENTRIES = 512;
/** Samples per key stop refining the mean after this — stays adaptive-ish
 *  without letting one hot type dominate the running mean's inertia. */
const MAX_SAMPLES_PER_KEY = 64;
/** Width buckets of 10dp: smaller deltas don't change template heights. */
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
  if (!(sizeDp > 0)) return; // zero/NaN = conditional-render artifacts
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

/** Mean for the key, or null when never measured. */
export function getCachedMean(key: string): number | null {
  return cache.get(key)?.mean ?? null;
}

/** Test hook. */
export function clearMeasurementCache(): void {
  cache.clear();
}
