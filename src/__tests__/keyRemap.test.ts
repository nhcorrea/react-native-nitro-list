import {describe, expect, it} from '@jest/globals';

import {buildKeyRemapPairs, REMAP_MIN_MAPPED_FRACTION} from '../keyRemap';

type Item = {id: string};

const key = (item: Item) => item.id;
const items = (...ids: string[]): Item[] => ids.map((id) => ({id}));

function pairsAsTuples(pairs: Float64Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pairs.length; i += 2) {
    out.push([pairs[i], pairs[i + 1]]);
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
    expect(pairsAsTuples(result!.pairs)).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
    ]);
    expect(result!.pairs.length).toBe(6);
    expect(result!.pairs.buffer.byteLength).toBe(6 * 8);
  });

  it('maps removals and reorders by key, not by position', () => {
    const prev = items('a', 'b', 'c', 'd');
    const next = items('d', 'b');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(pairsAsTuples(result!.pairs)).toEqual([
      [3, 0],
      [1, 1],
    ]);
  });

  it('includes identity survivors so the core keeps their measurements', () => {
    const prev = items('a', 'b');
    const next = items('a', 'b', 'c');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(result!.mappedCount).toBe(2);
    expect(pairsAsTuples(result!.pairs)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('returns null when nothing survives or an array is empty', () => {
    expect(buildKeyRemapPairs(items('a'), items('z'), key)).toBeNull();
    expect(buildKeyRemapPairs([], items('a'), key)).toBeNull();
    expect(buildKeyRemapPairs(items('a'), [], key)).toBeNull();
  });

  it('resolves duplicate keys to their first occurrence on both sides', () => {
    const prev = items('a', 'a', 'b');
    const next = items('a', 'a', 'b');
    const result = buildKeyRemapPairs(prev, next, key);
    expect(pairsAsTuples(result!.pairs)).toEqual([
      [0, 0],
      [0, 1],
      [2, 2],
    ]);
  });

  it('keeps the remap admission threshold at 60%', () => {
    expect(REMAP_MIN_MAPPED_FRACTION).toBeCloseTo(0.6);
  });
});
