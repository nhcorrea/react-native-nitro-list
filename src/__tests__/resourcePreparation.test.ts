import {afterEach, describe, expect, it} from '@jest/globals';

import {
  ResourcePreparationQueue,
  getPreparationQueueCounts,
  type PreparationEvent,
} from '../resourcePreparation';
import type {NitroListPrepareItem} from '../types';

type Gate = {resolve: () => void; reject: (error: Error) => void; signal: AbortSignal};

function entry(index: number): {item: string; index: number; key: string} {
  return {item: `item-${index}`, index, key: `key-${index}`};
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function gated(): {prepare: NitroListPrepareItem<string>; started: number[]; gates: Map<number, Gate>} {
  const started: number[] = [];
  const gates = new Map<number, Gate>();
  const prepare: NitroListPrepareItem<string> = ({index, signal}) => {
    started.push(index);
    return new Promise<void>((resolve, reject) => {
      gates.set(index, {resolve, reject, signal});
    });
  };
  return {prepare, started, gates};
}

describe('ResourcePreparationQueue', () => {
  const queues: Array<ResourcePreparationQueue<string>> = [];
  const pending: Gate[] = [];

  function track(queue: ResourcePreparationQueue<string>, gates: Map<number, Gate>): void {
    queues.push(queue);
    pending.push(...gates.values());
  }

  afterEach(async () => {
    for (const queue of queues) queue.clear();
    for (const gate of pending) gate.resolve();
    queues.length = 0;
    pending.length = 0;
    await settle();
  });

  it('runs at most the configured number of preparations at once', async () => {
    const {prepare, started, gates} = gated();
    const queue = new ResourcePreparationQueue<string>(2, 32);
    queue.propose([0, 1, 2, 3].map(entry), prepare);

    expect(started).toEqual([0, 1]);
    expect(queue.inspect()).toEqual({retained: 4, waiting: 2, inFlight: 2, prepared: 0});

    gates.get(0)!.resolve();
    await settle();

    expect(started).toEqual([0, 1, 2]);
    expect(queue.inspect()).toEqual({retained: 4, waiting: 1, inFlight: 2, prepared: 1});
    track(queue, gates);
  });

  it('passes the item, its index, its key and a live signal', () => {
    const calls: Array<{item: string; index: number; key: string; aborted: boolean}> = [];
    const queue = new ResourcePreparationQueue<string>(2, 32);
    queue.propose([entry(7)], ({item, index, key, signal}) => {
      calls.push({item, index, key, aborted: signal.aborted});
    });

    expect(calls).toEqual([{item: 'item-7', index: 7, key: 'key-7', aborted: false}]);
    queues.push(queue);
  });

  it('aborts what left the window and keeps what stayed', async () => {
    const {prepare, started, gates} = gated();
    const queue = new ResourcePreparationQueue<string>(2, 32);
    queue.propose([0, 1, 2].map(entry), prepare);
    queue.propose([2, 3].map(entry), prepare);

    expect(gates.get(0)!.signal.aborted).toBe(true);
    expect(gates.get(1)!.signal.aborted).toBe(true);
    expect(started).toEqual([0, 1]);
    expect(queue.inspect().retained).toBe(2);

    gates.get(0)!.resolve();
    gates.get(1)!.resolve();
    await settle();

    expect(started).toEqual([0, 1, 2, 3]);
    expect(gates.get(2)!.signal.aborted).toBe(false);
    expect(queue.inspect()).toEqual({retained: 2, waiting: 0, inFlight: 2, prepared: 0});
    track(queue, gates);
  });

  it('prepares an item again when its data or its callback changes', async () => {
    const first = gated();
    const second = gated();
    const queue = new ResourcePreparationQueue<string>(2, 32);
    queue.propose([entry(0)], first.prepare);
    queue.propose([{item: 'changed', index: 0, key: 'key-0'}], first.prepare);

    expect(first.started).toEqual([0, 0]);

    queue.propose([{item: 'changed', index: 0, key: 'key-0'}], second.prepare);

    expect(second.started).toEqual([]);

    for (const gate of first.gates.values()) gate.resolve();
    await settle();

    expect(second.started).toEqual([0]);
    track(queue, second.gates);
  });

  it('holds the slot of an aborted preparation until its promise settles', async () => {
    const {prepare, started, gates} = gated();
    const queue = new ResourcePreparationQueue<string>(1, 32);
    queue.propose([entry(0)], prepare);
    queue.propose([entry(1)], prepare);

    expect(gates.get(0)!.signal.aborted).toBe(true);
    expect(started).toEqual([0]);

    gates.get(0)!.resolve();
    await settle();

    expect(started).toEqual([0, 1]);
    track(queue, gates);
  });

  it('keeps going after a callback throws or rejects', async () => {
    const started: number[] = [];
    const queue = new ResourcePreparationQueue<string>(1, 32);
    queue.propose([0, 1, 2].map(entry), ({index}) => {
      started.push(index);
      if (index === 0) throw new Error('sync');
      if (index === 1) return Promise.reject(new Error('async'));
      return undefined;
    });
    await settle();

    expect(started).toEqual([0, 1, 2]);
    expect(queue.inspect()).toEqual({retained: 3, waiting: 0, inFlight: 0, prepared: 1});
    queues.push(queue);
  });

  it('drops entries beyond its capacity', () => {
    const {prepare, started, gates} = gated();
    const queue = new ResourcePreparationQueue<string>(1, 2);
    queue.propose([0, 1, 2, 3].map(entry), prepare);

    expect(queue.inspect().retained).toBe(2);
    expect(started).toEqual([0]);
    track(queue, gates);
  });

  it('aborts everything on clear and reports the totals across queues', async () => {
    const before = getPreparationQueueCounts();
    const {prepare, gates} = gated();
    const queue = new ResourcePreparationQueue<string>(2, 32);
    queue.propose([0, 1, 2].map(entry), prepare);

    expect(getPreparationQueueCounts().retained).toBe(before.retained + 3);

    queue.clear();

    expect([...gates.values()].every(gate => gate.signal.aborted)).toBe(true);
    expect(queue.inspect().retained).toBe(0);

    for (const gate of gates.values()) gate.resolve();
    await settle();

    expect(getPreparationQueueCounts()).toEqual(before);
  });

  it('reports each stage to its observer', async () => {
    const events: PreparationEvent[] = [];
    const queue = new ResourcePreparationQueue<string>(1, 32, event => events.push(event), () => 100);
    queue.propose([entry(0)], () => undefined);
    await settle();
    queue.clear();

    expect(events.map(event => event.stage)).toEqual(['queued', 'started', 'prepared', 'released']);
    expect(events.every(event => event.key === 'key-0' && event.index === 0)).toBe(true);
  });

  it('rejects an invalid capacity', () => {
    expect(() => new ResourcePreparationQueue<string>(0, 32)).toThrow('Invalid resource preparation capacity');
    expect(() => new ResourcePreparationQueue<string>(4, 2)).toThrow('Invalid resource preparation capacity');
  });
});
