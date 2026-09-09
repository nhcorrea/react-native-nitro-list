import {didKeysChangeStructurally, firstDifferingIndex} from './keyRemap';

export interface DataAnalysis<T> {
  previous: ReadonlyArray<T>;
  items: ReadonlyArray<T>;
  firstChanged: number;
  versionChanged: boolean;
  keysChanged: boolean;
}

/** One immutable description per render revision, published only on commit. */
export function analyzeData<T>(
  previous: ReadonlyArray<T>,
  items: ReadonlyArray<T>,
  versionChanged: boolean,
  keyExtractor?: (item: T, index: number) => string,
): DataAnalysis<T> {
  const firstChanged = versionChanged ? 0 : firstDifferingIndex(previous, items);
  const keysChanged =
    versionChanged ||
    (keyExtractor == null
      ? previous !== items
      : didKeysChangeStructurally(previous, items, keyExtractor, firstChanged));
  return {previous, items, firstChanged, versionChanged, keysChanged};
}
