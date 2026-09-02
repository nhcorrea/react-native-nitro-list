import {afterEach, describe, expect, it, jest} from '@jest/globals';

import {LatencyDistribution, NitroListPerfMonitor} from '../PerfMonitor';

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

describe('NitroListPerfMonitor content renders', () => {
  afterEach(() => {
    NitroListPerfMonitor.disable();
  });

  it('counts wrapper and content renders independently', () => {
    NitroListPerfMonitor.enable();
    for (let i = 0; i < 3; i++) NitroListPerfMonitor.recordItemRender();
    NitroListPerfMonitor.recordItemContentRender();

    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.itemRenders).toBe(3);
    expect(snap.itemContentRenders).toBe(1);
  });

  it('reset clears the content-render counter', () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordItemContentRender();
    NitroListPerfMonitor.reset();
    expect(NitroListPerfMonitor.getSnapshot().itemContentRenders).toBe(0);
  });
});

describe('NitroListPerfMonitor fling prewarm outcomes', () => {
  afterEach(() => {
    NitroListPerfMonitor.disable();
  });

  it('counts outcomes and misses separately', () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordFlingPrewarmOutcome(true);
    NitroListPerfMonitor.recordFlingPrewarmOutcome(false);
    NitroListPerfMonitor.recordFlingPrewarmOutcome(true);

    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.flingPrewarmOutcomes).toBe(3);
    expect(snap.flingPrewarmMisses).toBe(1);
  });

  it('reset clears both counters and disabled records are ignored', () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordFlingPrewarmOutcome(false);
    NitroListPerfMonitor.reset();
    expect(NitroListPerfMonitor.getSnapshot().flingPrewarmOutcomes).toBe(0);
    expect(NitroListPerfMonitor.getSnapshot().flingPrewarmMisses).toBe(0);

    NitroListPerfMonitor.disable();
    NitroListPerfMonitor.recordFlingPrewarmOutcome(false);
    expect(NitroListPerfMonitor.getSnapshot().flingPrewarmMisses).toBe(0);
  });
});

describe('NitroListPerfMonitor layout version bumps', () => {
  afterEach(() => {
    NitroListPerfMonitor.disable();
  });

  it('counts bumps and clears them on reset', () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordLayoutVersionBump();
    NitroListPerfMonitor.recordLayoutVersionBump();
    expect(NitroListPerfMonitor.getSnapshot().layoutVersionBumps).toBe(2);
    NitroListPerfMonitor.reset();
    expect(NitroListPerfMonitor.getSnapshot().layoutVersionBumps).toBe(0);
    NitroListPerfMonitor.disable();
    NitroListPerfMonitor.recordLayoutVersionBump();
    expect(NitroListPerfMonitor.getSnapshot().layoutVersionBumps).toBe(0);
  });
});

describe('NitroListPerfMonitor régua v5 counters', () => {
  it('counts user callbacks and orchestrator/cells renders, and resets them', () => {
    NitroListPerfMonitor.enable();
    NitroListPerfMonitor.recordUserCallbacks(3);
    NitroListPerfMonitor.recordUserCallbacks(2);
    NitroListPerfMonitor.recordOrchestratorRender();
    NitroListPerfMonitor.recordCellsRender();
    const snap = NitroListPerfMonitor.getSnapshot();
    expect(snap.userCallbacks).toBe(5);
    expect(snap.orchestratorRenders).toBe(1);
    expect(snap.cellsRenders).toBe(1);
    NitroListPerfMonitor.reset();
    expect(NitroListPerfMonitor.getSnapshot().userCallbacks).toBe(0);
    expect(NitroListPerfMonitor.getSnapshot().orchestratorRenders).toBe(0);
    NitroListPerfMonitor.disable();
    NitroListPerfMonitor.recordUserCallbacks(1);
    expect(NitroListPerfMonitor.getSnapshot().userCallbacks).toBe(0);
  });
});
