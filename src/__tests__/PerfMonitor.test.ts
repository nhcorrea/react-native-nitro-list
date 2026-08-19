import {afterEach, describe, expect, it, jest} from '@jest/globals';

import {LatencyDistribution, NitroListPerfMonitor} from '../PerfMonitor';

/** Flushes the microtask queue so mount bursts recorded via queueMicrotask land. */
const flushMicrotasks = () => Promise.resolve();

describe('LatencyDistribution', () => {
  it('reports nearest-rank percentiles and max', () => {
    const dist = new LatencyDistribution();
    for (let i = 1; i <= 100; i++) dist.record(i);
    const snap = dist.snapshot();
    expect(snap.count).toBe(100);
    expect(snap.max).toBe(100);
    expect(snap.p50).toBe(50);
    expect(snap.p95).toBe(95);
    expect(snap.p99).toBe(99);
  });

  it('returns zeros when empty', () => {
    expect(new LatencyDistribution().snapshot()).toEqual({count: 0, max: 0, p50: 0, p95: 0, p99: 0});
  });

  it('grows past the initial buffer and sorts numerically', () => {
    const dist = new LatencyDistribution();
    // Descending insert order + >256 samples: exercises growth and the sort.
    for (let i = 1000; i >= 1; i--) dist.record(i);
    const snap = dist.snapshot();
    expect(snap.count).toBe(1000);
    expect(snap.p50).toBe(500);
    expect(snap.p99).toBe(990);
  });

  it('reset clears samples and counters', () => {
    const dist = new LatencyDistribution();
    dist.record(42);
    dist.reset();
    expect(dist.snapshot().count).toBe(0);
    dist.record(7);
    expect(dist.snapshot()).toMatchObject({count: 1, max: 7, p50: 7});
  });
});

describe('NitroListPerfMonitor mount bursts', () => {
  afterEach(() => {
    NitroListPerfMonitor.disable();
  });

  it('groups synchronous mounts into one burst per microtask flush', async () => {
    NitroListPerfMonitor.enable();
    for (let i = 0; i < 5; i++) NitroListPerfMonitor.recordItemMount();
    await flushMicrotasks();
    NitroListPerfMonitor.recordItemMount();
    NitroListPerfMonitor.recordItemMount();
    await flushMicrotasks();

    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.itemMounts).toBe(7);
    expect(snap.mountBurst.count).toBe(2);
    expect(snap.mountBurst.max).toBe(5);
    // Sorted bursts [2, 5] — nearest-rank p50 is the first.
    expect(snap.mountBurst.p50).toBe(2);
  });

  it('drops a burst that was pending across a reset', async () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordItemMount();
    NitroListPerfMonitor.reset();
    await flushMicrotasks();
    expect(NitroListPerfMonitor.getSnapshot().mountBurst.count).toBe(0);
  });
});

describe('NitroListPerfMonitor range latency tail', () => {
  afterEach(() => {
    NitroListPerfMonitor.disable();
    jest.useRealTimers();
  });

  it('records scroll→range deltas into the tail distribution', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    NitroListPerfMonitor.enable();

    NitroListPerfMonitor.markScrollDispatch();
    jest.setSystemTime(1_000_012);
    NitroListPerfMonitor.recordRangeEvent();

    NitroListPerfMonitor.markScrollDispatch();
    jest.setSystemTime(1_000_060);
    NitroListPerfMonitor.recordRangeEvent();

    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.rangeLatencySamples).toBe(2);
    expect(snap.rangeLatencyTail.count).toBe(2);
    expect(snap.rangeLatencyTail.max).toBe(48);
    expect(snap.rangeLatencyTail.p99).toBe(48);
  });

  it('ignores deltas outside the latency window, same as avg/max', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_000_000);
    NitroListPerfMonitor.enable();

    NitroListPerfMonitor.markScrollDispatch();
    jest.setSystemTime(2_000_500);
    NitroListPerfMonitor.recordRangeEvent();

    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.rangeLatencySamples).toBe(0);
    expect(snap.rangeLatencyTail.count).toBe(0);
  });
});
