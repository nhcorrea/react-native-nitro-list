import {describe, expect, it} from '@jest/globals';

import {createDataChangeHandler, type DataChangeCtx} from '../dataChanges';
import type {KeyRemapPairs} from '../keyRemap';

type Item = {id: string; rev?: number};
type Anchor = {index: number; key: string | null; offset: number};

const ROW = 100;

const pool = new Map<string, Item>();
const items = (...ids: string[]): Item[] =>
  ids.map((id) => {
    let item = pool.get(id);
    if (item == null) {
      item = {id};
      pool.set(id, item);
    }
    return item;
  });

function referenceAnchorIndex(
  next: ReadonlyArray<Item>,
  keyOf: (item: Item, index: number) => string,
  anchor: {index: number; key: string},
): number {
  const same = next[anchor.index];
  if (same !== undefined && keyOf(same, anchor.index) === anchor.key) return anchor.index;
  return next.findIndex((item, index) => keyOf(item, index) === anchor.key);
}

function run(options: {
  prev: Item[];
  next: Item[];
  anchor: Anchor | null;
  keyOf?: (item: Item, index: number) => string;
  dataVersion?: {before: unknown; after: unknown};
}) {
  const keyOf = options.keyOf ?? ((item: Item) => item.id);
  let keyCalls = 0;
  const commits: Array<{remap: KeyRemapPairs | null; reset: boolean}> = [];
  const corrections: number[] = [];
  const mvcpState = {current: {enabled: true, anchor: options.anchor}};
  const ctx: DataChangeCtx<Item> = {
    commitData: (remap, reset) => {
      commits.push({remap, reset});
    },
    analysis: {
      previous: options.prev,
      items: options.next,
      firstChanged: 0,
      versionChanged: options.dataVersion != null,
      keysChanged: true,
    },
    items: options.next,
    dataVersion: options.dataVersion?.after,
    keyExtractor: (item, index) => {
      keyCalls++;
      return keyOf(item, index);
    },
    previousItemsRef: {current: options.prev},
    previousDataVersionRef: {current: options.dataVersion?.before},
    dataJustChangedRef: {current: false},
    engineRef: {current: null},
    mvcpStateRef: mvcpState,
    mvcpResolvedRef: {current: {size: true, data: true}},
    applyMvcpCorrectionRef: {current: (diff: number) => corrections.push(diff)},
    viewableRef: {current: new Map()},
    pendingRef: {current: new Map()},
    isPrewarmingRangeRef: {current: false},
    lastPrewarmRangeRef: {current: null},
    lastViewabilityEvalRef: {current: {offset: 0, start: 0, end: 0, layoutVersion: 0}},
    viewabilityTimerRef: {current: null},
    cancelFlingPrewarm: () => {},
    setPrewarmRangeTracked: () => {},
    invalidateLayoutCache: () => {},
    readItemOffset: (index) => index * ROW,
    evaluateViewability: () => {},
  };
  createDataChangeHandler(ctx)();
  return {keyCalls, commits, corrections, anchor: mvcpState.current.anchor};
}

const letters = 'abcdefghij'.split('');

describe('data change handler: remap pairs and anchor lookup', () => {
  const scenarios: Array<{
    name: string;
    prev: Item[];
    next: Item[];
    anchor: {index: number; key: string};
    keyOf?: (item: Item, index: number) => string;
    remapped: boolean;
  }> = [
    {name: 'prepend', prev: items(...letters), next: items('x', 'y', ...letters), anchor: {index: 3, key: 'd'}, remapped: true},
    {name: 'head removal', prev: items(...letters), next: items(...letters.slice(2)), anchor: {index: 3, key: 'd'}, remapped: true},
    {name: 'reorder', prev: items(...letters), next: items(...[...letters].reverse()), anchor: {index: 3, key: 'd'}, remapped: true},
    {name: 'zero survivors', prev: items(...letters), next: items('p', 'q', 'r'), anchor: {index: 1, key: 'b'}, remapped: false},
    {name: 'below the 60% threshold', prev: items(...letters), next: items('a', 'b', 'c', 'd', 'e', 'v', 'w', 'x', 'y', 'z'), anchor: {index: 3, key: 'd'}, remapped: false},
    {name: 'anchor lost', prev: items(...letters), next: items(...letters.filter((l) => l !== 'd')), anchor: {index: 3, key: 'd'}, remapped: true},
    {name: 'duplicate keys away from the previous index', prev: items('a', 'b', 'a', 'c'), next: items('x', 'a', 'b', 'a', 'c'), anchor: {index: 2, key: 'a'}, remapped: true},
    {name: 'duplicate keys at the previous index', prev: items('a', 'b', 'a', 'c'), next: items('a', 'b', 'a', 'c', 'd'), anchor: {index: 2, key: 'a'}, remapped: true},
    {
      name: 'index-dependent keys',
      prev: items(...letters),
      next: items('x', ...letters),
      keyOf: (item, index) => (item.id === 'x' ? 'x' : String(index)),
      anchor: {index: 3, key: '3'},
      remapped: false,
    },
  ];

  it.each(scenarios)('$name: same anchor as the reference search with one key walk', (scenario) => {
    const keyOf = scenario.keyOf ?? ((item: Item) => item.id);
    const offset = 250;
    const result = run({
      prev: scenario.prev,
      next: scenario.next,
      keyOf,
      anchor: {...scenario.anchor, offset},
    });
    const expected = referenceAnchorIndex(scenario.next, keyOf, scenario.anchor);
    expect(result.keyCalls).toBe(scenario.prev.length + scenario.next.length);
    if (expected < 0) {
      expect(result.anchor).toBeNull();
      expect(result.corrections).toEqual([]);
    } else {
      expect(result.anchor).toMatchObject({index: expected, key: scenario.anchor.key});
      const diff = expected * ROW - offset;
      expect(result.corrections).toEqual(diff === 0 ? [] : [diff]);
    }
    const [commit] = result.commits;
    expect(commit.reset).toBe(!scenario.remapped);
    if (scenario.remapped) {
      expect(commit.remap!.pairs.length).toBeGreaterThanOrEqual(scenario.next.length * 2);
      expect(commit.remap!.mappedCount).toBeGreaterThanOrEqual(scenario.next.length * 0.6);
    } else {
      expect(commit.remap).toBeNull();
    }
  });

  it('keeps an anchor whose key survives with new content, without remapping its measurement', () => {
    const prev = items(...letters);
    const next = prev.map((item) => (item.id === 'd' ? {id: 'd', rev: 2} : item));
    const result = run({prev, next, anchor: {index: 3, key: 'd', offset: 300}});
    expect(result.anchor).toMatchObject({index: 3, key: 'd'});
    const remap = result.commits[0].remap!;
    expect(remap.mappedCount).toBe(prev.length - 1);
    const destinations = Array.from({length: remap.mappedCount}, (_, i) => remap.pairs[i * 2 + 1]);
    expect(destinations).not.toContain(3);
  });

  it('falls back to the conservative search when dataVersion skips the remap walk', () => {
    const prev = items(...letters);
    const next = items('x', ...letters);
    const result = run({
      prev,
      next,
      anchor: {index: 3, key: 'd', offset: 300},
      dataVersion: {before: 1, after: 2},
    });
    expect(result.commits[0]).toEqual({remap: null, reset: true});
    expect(result.anchor).toMatchObject({index: 4, key: 'd'});
    expect(result.keyCalls).toBe(1 + 5);
  });
});
