import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  MOUNT_ACK_TIMEOUT_MS,
  MOUNT_COST_PRIOR_MS,
  MOUNT_SLICE_MAX_ITEMS,
  MountGate,
  nextSliceSize,
  updateMountCost,
} from '../mountAdmission';

function gate() {
  const published: number[] = [];
  return {gate: new MountGate({set: (_key, value) => published.push(value)}), published};
}

describe('mount admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sizes a slice to the frame budget from the observed cost per item', () => {
    expect(nextSliceSize(MOUNT_COST_PRIOR_MS)).toBe(2);
    expect(nextSliceSize(0.5)).toBe(10);
    expect(nextSliceSize(0.01)).toBe(MOUNT_SLICE_MAX_ITEMS);
    expect(nextSliceSize(40)).toBe(1);
  });

  it('learns the cost per item without collapsing on one cheap mount', () => {
    let cost = MOUNT_COST_PRIOR_MS;
    for (let k = 0; k < 20; k++) cost = updateMountCost(cost, 2, 4);
    expect(cost).toBeCloseTo(0.5, 1);
    const afterCheap = updateMountCost(cost, 0, 4);
    expect(afterCheap).toBeGreaterThanOrEqual(cost * 0.8);
    expect(updateMountCost(cost, 10, 0)).toBe(cost);
  });

  it('releases the next slice only after the native mount of the previous one', () => {
    const {gate: g, published} = gate();
    g.available = true;
    const next = jest.fn();
    const sequence = g.publish(2);
    expect(published).toEqual([sequence]);
    g.afterMount(sequence, next);
    g.onMounted(sequence - 1, 3);
    expect(next).not.toHaveBeenCalled();
    g.onMounted(sequence, 3);
    expect(next).toHaveBeenCalledTimes(1);
    expect(g.costPerItemMs).toBeLessThan(MOUNT_COST_PRIOR_MS);
  });

  it('a later acknowledgement covers earlier slices mounted in the same batch', () => {
    const {gate: g} = gate();
    const first = jest.fn();
    const second = jest.fn();
    const a = g.publish(2);
    const b = g.publish(2);
    g.afterMount(a, first);
    g.afterMount(b, second);
    g.onMounted(b, 4);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('falls back to a timeout when no acknowledgement arrives', () => {
    const {gate: g} = gate();
    const next = jest.fn();
    g.afterMount(g.publish(1), next);
    jest.advanceTimersByTime(MOUNT_ACK_TIMEOUT_MS - 1);
    expect(next).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('cancelled and reset waiters never fire', () => {
    const {gate: g} = gate();
    const cancelled = jest.fn();
    const pending = jest.fn();
    const cancel = g.afterMount(g.publish(1), cancelled);
    cancel();
    g.afterMount(g.publish(1), pending);
    g.reset();
    jest.advanceTimersByTime(MOUNT_ACK_TIMEOUT_MS * 2);
    g.onMounted(2, 1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
  });
});
