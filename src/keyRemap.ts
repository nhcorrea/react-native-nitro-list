import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

export const REMAP_MIN_MAPPED_FRACTION = 0.6;

export type KeyRemapResult = {
  pairs: Float64Array;
  mappedCount: number;
};

export function buildKeyRemapPairs<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
): KeyRemapResult | null {
  if (prev.length === 0 || next.length === 0) return null;
  const oldIndexByKey = new Map<string, number>();
  for (let i = 0; i < prev.length; i++) {
    const key = keyExtractor(prev[i], i);
    if (!oldIndexByKey.has(key)) oldIndexByKey.set(key, i);
  }
  let pairs = new Float64Array(next.length * 2);
  let mappedCount = 0;
  for (let i = 0; i < next.length; i++) {
    const oldIndex = oldIndexByKey.get(keyExtractor(next[i], i));
    if (oldIndex == null) continue;
    pairs[mappedCount * 2] = oldIndex;
    pairs[mappedCount * 2 + 1] = i;
    mappedCount++;
  }
  if (mappedCount === 0) return null;
  if (mappedCount < next.length) {
    pairs = pairs.slice(0, mappedCount * 2);
  }
  return {pairs, mappedCount};
}

export function didKeysChangeStructurally<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
): boolean {
  const common = Math.min(prev.length, next.length);
  for (let i = 0; i < common; i++) {
    const p = prev[i];
    const n = next[i];
    if (p === n) continue;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordUserCallbacks(2);
    if (keyExtractor(p, i) !== keyExtractor(n, i)) return true;
  }
  return false;
}

export function firstDifferingIndex<T>(prev: ReadonlyArray<T>, next: ReadonlyArray<T>): number {
  const common = Math.min(prev.length, next.length);
  let i = 0;
  while (i < common && prev[i] === next[i]) i++;
  return i;
}

