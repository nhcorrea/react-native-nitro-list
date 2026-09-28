import {describe, expect, it} from '@jest/globals';

import {buildKeyRemapPairs, REMAP_MIN_MAPPED_FRACTION} from '../keyRemap';

type Item = {id: string};

const key = (item: Item) => item.id;
const items = (...ids: string[]): Item[] => ids.map((id) => ({id}));

function pairsAsTuples(result: {pairs: Float64Array; mappedCount: number}): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < result.mappedCount; i++) {
    out.push([result.pairs[i * 2], result.pairs[i * 2 + 1]]);
  }
  return out;
}

describe('buildKeyRemapPairs', () => {
  it('maps a prepend as a full survivor shift', () => {
    const prev = items('a', 'b', 'c');
    const next = items('x', 'y', 'a', 'b', 'c');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(result).not.toBeNull();
    expect(result!.mappedCount).toBe(3);
    expect(pairsAsTuples(result!)).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
    ]);
    expect(result!.pairs.length).toBe(next.length * 2);
    expect(result!.pairs.buffer.byteLength).toBe(next.length * 2 * 8);
  });

  it('maps removals and reorders by key, not by position', () => {
    const prev = items('a', 'b', 'c', 'd');
    const next = items('d', 'b');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(pairsAsTuples(result!)).toEqual([
      [3, 0],
      [1, 1],
    ]);
  });

  it('includes identity survivors so the core keeps their measurements', () => {
    const prev = items('a', 'b');
    const next = items('a', 'b', 'c');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(result!.mappedCount).toBe(2);
    expect(pairsAsTuples(result!)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('reports zero survivors with a count instead of dropping the walk', () => {
    const result = buildKeyRemapPairs(items('a'), items('z'), key);
    expect(result!.mappedCount).toBe(0);
    expect(result!.anchorIndex).toBe(-1);
  });

  it('returns null only when an array is empty', () => {
    expect(buildKeyRemapPairs([], items('a'), key)).toBeNull();
    expect(buildKeyRemapPairs(items('a'), [], key)).toBeNull();
  });

  it('resolves duplicate keys to their first occurrence on both sides', () => {
    const prev = items('a', 'a', 'b');
    const next = items('a', 'a', 'b');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(pairsAsTuples(result!)).toEqual([
      [0, 0],
      [0, 1],
      [2, 2],
    ]);
  });

  it('hands over the operation buffer with its valid count instead of a trimmed copy', () => {
    const prev = items('a', 'b', 'c', 'd');
    const next = items('a', 'x', 'c', 'y', 'z');
    const result = buildKeyRemapPairs(prev, next, key)!;
    expect(result.mappedCount).toBe(2);
    expect(result.pairs.length).toBe(next.length * 2);
    expect(pairsAsTuples(result)).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('resolves the anchor during the walk, preferring its previous index', () => {
    const prev = items('a', 'b', 'a', 'c');
    expect(buildKeyRemapPairs(prev, items('x', 'a', 'b', 'a', 'c'), key, undefined, {index: 2, key: 'a'})!
      .anchorIndex).toBe(1);
    expect(buildKeyRemapPairs(prev, items('a', 'b', 'a', 'c', 'd'), key, undefined, {index: 2, key: 'a'})!
      .anchorIndex).toBe(2);
    expect(buildKeyRemapPairs(prev, items('x', 'y', 'b', 'c'), key, undefined, {index: 2, key: 'a'})!
      .anchorIndex).toBe(-1);
  });

  it('locates the anchor by key even when its content is no longer equivalent', () => {
    const prev = items('a', 'b', 'c');
    const next = items('a', 'b', 'c');
    const result = buildKeyRemapPairs(prev, next, key, (p, n) => p === n, {index: 1, key: 'b'})!;
    expect(result.mappedCount).toBe(0);
    expect(result.anchorIndex).toBe(1);
  });

  it('keeps the remap admission threshold at 60%', () => {
    expect(REMAP_MIN_MAPPED_FRACTION).toBeCloseTo(0.6);
  });
});
