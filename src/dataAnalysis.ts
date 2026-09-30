import {didKeysChangeStructurally, firstDifferingIndex} from './keyRemap';

export interface DataAnalysis {
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
): DataAnalysis {
  const firstChanged = versionChanged ? 0 : firstDifferingIndex(previous, items);
  const keysChanged =
    versionChanged ||
    (keyExtractor == null
      ? previous !== items
      : didKeysChangeStructurally(previous, items, keyExtractor, firstChanged));
  return {firstChanged, versionChanged, keysChanged};
}
