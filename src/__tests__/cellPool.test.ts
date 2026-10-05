import {describe, expect, it} from '@jest/globals';

import {assignCellSlots, emptyCellPool, MAX_PARKED_CELLS, type CellPool} from '../cells';

type Window = Array<{index: number; type: string}>;

function entriesFor(window: Window) {
  return window.map(({index, type}) => ({
    index,
    item: index,
    top: index * 10,
    metadata: {
      reactKey: `${type.length}:${type}${index}`,
      typeKey: type,
      itemType: undefined,
      explicitFixedSize: undefined,
    },
  }));
}

function step(pool: CellPool, window: Window, canPark: (slot: number) => boolean = () => true) {
  const assigned = assignCellSlots(pool, entriesFor(window) as never, canPark);
  for (const slot of assigned.slots) assigned.pool.elements.set(slot, {props: {}} as never);
  for (const slot of assigned.parked) assigned.pool.elements.set(slot, {props: {}} as never);
  return assigned;
}

function block(start: number, length: number, type: string): Window {
  return Array.from({length}, (_, k) => ({index: start + k, type}));
}

describe('cell pool', () => {
  it('keeps every per-slot structure bounded by the window plus the reserve across thousands of windows', () => {
    let pool = emptyCellPool();
    const bound = 40 + MAX_PARKED_CELLS;
    for (let w = 0; w < 1000; w++) {
      pool = step(pool, block(w * 40, 40, w % 2 === 0 ? 'string:a' : 'string:b')).pool;
      expect(pool.order.length).toBeLessThanOrEqual(bound);
      expect(pool.lastKeys.size).toBeLessThanOrEqual(bound);
      expect(pool.types.size).toBeLessThanOrEqual(bound);
      expect(pool.elements.size).toBeLessThanOrEqual(bound);
      expect(pool.slots.size).toBeLessThanOrEqual(40);
      expect(pool.demand.size).toBeLessThanOrEqual(2);
    }
    expect(new Set(pool.order).size).toBe(pool.order.length);
  });

  it('lists retained slots in ascending order so mounted slots never move', () => {
    let pool = emptyCellPool();
    for (let w = 0; w < 200; w++) {
      pool = step(pool, block((w % 7) * 30, 25 + (w % 4) * 5, w % 3 === 0 ? 'string:a' : 'string:b')).pool;
      for (let k = 1; k < pool.order.length; k++) expect(pool.order[k]).toBeGreaterThan(pool.order[k - 1]);
    }
  });

  it('keeps a visible item on its slot and returns an item to its own parked slot', () => {
    let pool = step(emptyCellPool(), block(0, 10, 'string:a')).pool;
    const slotOf3 = pool.slots.get('8:string:a3');
    pool = step(pool, block(3, 10, 'string:a')).pool;
    expect(pool.slots.get('8:string:a3')).toBe(slotOf3);
    const slotOf20 = (pool = step(pool, block(20, 10, 'string:a')).pool).slots.get('8:string:a20');
    pool = step(pool, block(100, 3, 'string:b')).pool;
    pool = step(pool, block(20, 10, 'string:a')).pool;
    expect(pool.slots.get('8:string:a20')).toBe(slotOf20);
  });

  it('limits the reserve of a rare type to its observed demand', () => {
    let pool = step(emptyCellPool(), [...block(0, 30, 'string:a'), {index: 30, type: 'string:rare'}]).pool;
    const assigned = step(pool, block(500, 30, 'string:b'));
    const parkedTypes = assigned.parked.map((slot) => assigned.pool.types.get(slot));
    expect(parkedTypes.filter((type) => type === 'string:rare')).toHaveLength(1);
    expect(parkedTypes.filter((type) => type === 'string:a').length).toBeLessThanOrEqual(MAX_PARKED_CELLS - 1);
    expect(assigned.parked.length).toBeLessThanOrEqual(MAX_PARKED_CELLS);
    pool = assigned.pool;
    expect(pool.demand.get('string:rare')).toBe(1);
  });

  it('shares the reserve between types instead of filling it with the first one', () => {
    const pool = step(emptyCellPool(), [...block(0, 40, 'string:a'), ...block(40, 40, 'string:b')]).pool;
    const assigned = step(pool, block(1000, 10, 'string:c'));
    const parkedTypes = assigned.parked.map((slot) => assigned.pool.types.get(slot));
    expect(parkedTypes.filter((type) => type === 'string:a')).toHaveLength(MAX_PARKED_CELLS / 2);
    expect(parkedTypes.filter((type) => type === 'string:b')).toHaveLength(MAX_PARKED_CELLS / 2);
  });

  it('drops stale slots and their metadata instead of parking them', () => {
    let pool = step(emptyCellPool(), block(0, 10, 'string:a')).pool;
    const assigned = step(pool, block(50, 2, 'string:b'), () => false);
    expect(assigned.parked).toHaveLength(0);
    pool = assigned.pool;
    expect(pool.order).toHaveLength(2);
    expect(pool.lastKeys.size).toBe(2);
    expect(pool.types.size).toBe(2);
    expect(pool.demand.has('string:a')).toBe(false);
  });
});
