import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

export const REMAP_MIN_MAPPED_FRACTION = 0.6;

export type KeyRemapPairs = {
  pairs: Float64Array;
  mappedCount: number;
};

export type KeyRemapResult = KeyRemapPairs & {
  anchorIndex: number;
};

export type KeyRemapAnchor = {
  index: number;
  key: string;
};

export function buildKeyRemapPairs<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
  equivalent?: (previous: T, next: T, index: number) => boolean,
  anchor?: KeyRemapAnchor | null,
): KeyRemapResult | null {
  if (prev.length === 0 || next.length === 0) return null;
  const oldIndexByKey = new Map<string, number>();
  for (let i = 0; i < prev.length; i++) {
    const key = keyExtractor(prev[i], i);
    if (!oldIndexByKey.has(key)) oldIndexByKey.set(key, i);
  }
  const pairs = new Float64Array(next.length * 2);
  let mappedCount = 0;
  let anchorIndex = -1;
  for (let i = 0; i < next.length; i++) {
    const key = keyExtractor(next[i], i);
    if (anchor != null && key === anchor.key && (anchorIndex < 0 || i === anchor.index)) {
      anchorIndex = i;
    }
    const oldIndex = oldIndexByKey.get(key);
    if (oldIndex == null || (equivalent != null && !equivalent(prev[oldIndex], next[i], i))) continue;
    pairs[mappedCount * 2] = oldIndex;
    pairs[mappedCount * 2 + 1] = i;
    mappedCount++;
  }
  return {pairs, mappedCount, anchorIndex};
}

export function didKeysChangeStructurally<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
  from = 0,
): boolean {
  const common = Math.min(prev.length, next.length);
  for (let i = from; i < common; i++) {
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

