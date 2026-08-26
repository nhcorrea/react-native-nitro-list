
function benchGlobalFlag(): boolean {
  const g = globalThis as {__NITRO_LIST_PERF__?: boolean};
  return g.__NITRO_LIST_PERF__ === true;
}

export const NITRO_LIST_PERF_COMPILED =
  (typeof __DEV__ !== 'undefined' && __DEV__) ||
  process.env.EXPO_PUBLIC_NITRO_BENCH === '1' ||
  benchGlobalFlag();

export interface NitroListScrollToIndexStats {
  durationMs: number;
  prewarmRestarts: number;
  correctionPasses: number;
  animated: boolean;
}

export interface NitroListPerfSnapshot {
  enabled: boolean;
  windowMs: number;
  scrollSamples: number;
  blankSamples: number;
  blankPxMax: number;
  blankPxSum: number;
  rangeEvents: number;
  rangeLatencySamples: number;
  rangeLatencySumMs: number;
  rangeLatencyMaxMs: number;
  rangeLatencyTail: LatencyDistributionSnapshot;
  mountBurst: LatencyDistributionSnapshot;
  jsiCalls: number;
  batchFlushes: number;
  batchPairsSum: number;
  batchPairsMax: number;
  itemMounts: number;
  itemUnmounts: number;
  itemRenders: number;
  itemContentRenders: number;
  firstRangeLatencyMs: number | null;
  scrollToIndexStarts: number;
  scrollToIndexCompletions: number;
  lastScrollToIndex: NitroListScrollToIndexStats | null;
  flingPrewarmOutcomes: number;
  flingPrewarmMisses: number;
  layoutVersionBumps: number;
}

const RANGE_LATENCY_WINDOW_MS = 200;

export interface LatencyDistributionSnapshot {
  count: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

const EMPTY_DISTRIBUTION: LatencyDistributionSnapshot = {count: 0, max: 0, p50: 0, p95: 0, p99: 0};

export class LatencyDistribution {
  private samples = new Float64Array(256);
  private stored = 0;
  private count = 0;
  private max = 0;

  private static readonly CAPACITY = 32_768;

  record(value: number) {
    this.count++;
    if (value > this.max) this.max = value;
    if (this.stored >= LatencyDistribution.CAPACITY) return;
    if (this.stored === this.samples.length) {
      const grown = new Float64Array(Math.min(this.samples.length * 2, LatencyDistribution.CAPACITY));
      grown.set(this.samples);
      this.samples = grown;
    }
    this.samples[this.stored++] = value;
  }

  reset() {
    this.stored = 0;
    this.count = 0;
    this.max = 0;
  }

  snapshot(): LatencyDistributionSnapshot {
    if (this.count === 0) return EMPTY_DISTRIBUTION;
    const sorted = this.samples.slice(0, this.stored).sort();
    const rank = (p: number) => sorted[Math.min(this.stored - 1, Math.ceil((p / 100) * this.stored) - 1)];
    return {count: this.count, max: this.max, p50: rank(50), p95: rank(95), p99: rank(99)};
  }
}

class NitroListPerfMonitorImpl {
  enabled = false;

  private startedAt = 0;
  private scrollSamples = 0;
  private blankSamples = 0;
  private blankPxMax = 0;
  private blankPxSum = 0;
  private rangeEvents = 0;
  private rangeLatencySamples = 0;
  private rangeLatencySumMs = 0;
  private rangeLatencyMaxMs = 0;
  private lastScrollDispatchAt = 0;
  private jsiCalls = 0;
  private batchFlushes = 0;
  private batchPairsSum = 0;
  private batchPairsMax = 0;
  private itemMounts = 0;
  private itemUnmounts = 0;
  private itemRenders = 0;
  private itemContentRenders = 0;
  private readonly rangeLatencyDist = new LatencyDistribution();
  private readonly mountBurstDist = new LatencyDistribution();
  private pendingMountBurst = 0;
  private firstRangeLatencyMs: number | null = null;
  private scrollToIndexStarts = 0;
  private scrollToIndexCompletions = 0;
  private lastScrollToIndex: NitroListScrollToIndexStats | null = null;
  private flingPrewarmOutcomes = 0;
  private flingPrewarmMisses = 0;
  private layoutVersionBumps = 0;

  enable() {
    this.enabled = true;
    this.reset();
  }

  disable() {
    this.enabled = false;
  }

  reset() {
    this.startedAt = Date.now();
    this.scrollSamples = 0;
    this.blankSamples = 0;
    this.blankPxMax = 0;
    this.blankPxSum = 0;
    this.rangeEvents = 0;
    this.rangeLatencySamples = 0;
    this.rangeLatencySumMs = 0;
    this.rangeLatencyMaxMs = 0;
    this.lastScrollDispatchAt = 0;
    this.jsiCalls = 0;
    this.batchFlushes = 0;
    this.batchPairsSum = 0;
    this.batchPairsMax = 0;
    this.itemMounts = 0;
    this.itemUnmounts = 0;
    this.itemRenders = 0;
    this.itemContentRenders = 0;
    this.rangeLatencyDist.reset();
    this.mountBurstDist.reset();
    this.pendingMountBurst = 0;
    this.firstRangeLatencyMs = null;
    this.scrollToIndexStarts = 0;
    this.scrollToIndexCompletions = 0;
    this.lastScrollToIndex = null;
    this.flingPrewarmOutcomes = 0;
    this.flingPrewarmMisses = 0;
    this.layoutVersionBumps = 0;
  }

  recordScrollSample(blankPx: number) {
    if (!this.enabled) return;
    this.scrollSamples++;
    if (blankPx > 0.5) {
      this.blankSamples++;
      this.blankPxSum += blankPx;
      if (blankPx > this.blankPxMax) this.blankPxMax = blankPx;
    }
  }

  markScrollDispatch() {
    if (!this.enabled) return;
    this.lastScrollDispatchAt = Date.now();
  }

  clearScrollDispatchMark() {
    this.lastScrollDispatchAt = 0;
  }

  recordRangeEvent() {
    if (!this.enabled) return;
    this.rangeEvents++;
    const dispatchedAt = this.lastScrollDispatchAt;
    if (dispatchedAt > 0) {
      this.lastScrollDispatchAt = 0;
      const delta = Date.now() - dispatchedAt;
      if (delta <= RANGE_LATENCY_WINDOW_MS) {
        this.rangeLatencySamples++;
        this.rangeLatencySumMs += delta;
        if (delta > this.rangeLatencyMaxMs) this.rangeLatencyMaxMs = delta;
        this.rangeLatencyDist.record(delta);
      }
    }
  }

  recordJsiCall() {
    if (!this.enabled) return;
    this.jsiCalls++;
  }

  recordBatchFlush(pairCount: number) {
    if (!this.enabled) return;
    this.batchFlushes++;
    this.batchPairsSum += pairCount;
    if (pairCount > this.batchPairsMax) this.batchPairsMax = pairCount;
  }

  recordItemMount() {
    if (!this.enabled) return;
    this.itemMounts++;
    if (this.pendingMountBurst === 0) {
      queueMicrotask(() => {
        if (this.pendingMountBurst > 0) {
          if (this.enabled) this.mountBurstDist.record(this.pendingMountBurst);
          this.pendingMountBurst = 0;
        }
      });
    }
    this.pendingMountBurst++;
  }

  recordItemUnmount() {
    if (!this.enabled) return;
    this.itemUnmounts++;
  }

  recordItemRender() {
    if (!this.enabled) return;
    this.itemRenders++;
  }

  recordItemContentRender() {
    if (!this.enabled) return;
    this.itemContentRenders++;
  }

  recordFirstRange(anchorTimestampMs: number) {
    if (!this.enabled) return;
    if (this.firstRangeLatencyMs == null) {
      this.firstRangeLatencyMs = Date.now() - Math.max(anchorTimestampMs, this.startedAt);
    }
  }

  recordScrollToIndexStart() {
    if (!this.enabled) return;
    this.scrollToIndexStarts++;
  }

  recordScrollToIndexComplete(stats: NitroListScrollToIndexStats) {
    if (!this.enabled) return;
    this.scrollToIndexCompletions++;
    this.lastScrollToIndex = stats;
  }

  recordFlingPrewarmOutcome(covered: boolean) {
    if (!this.enabled) return;
    this.flingPrewarmOutcomes++;
    if (!covered) this.flingPrewarmMisses++;
  }

  recordLayoutVersionBump() {
    if (!this.enabled) return;
    this.layoutVersionBumps++;
  }

  getSnapshot(): NitroListPerfSnapshot {
    return {
      enabled: this.enabled,
      windowMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      scrollSamples: this.scrollSamples,
      blankSamples: this.blankSamples,
      blankPxMax: this.blankPxMax,
      blankPxSum: this.blankPxSum,
      rangeEvents: this.rangeEvents,
      rangeLatencySamples: this.rangeLatencySamples,
      rangeLatencySumMs: this.rangeLatencySumMs,
      rangeLatencyMaxMs: this.rangeLatencyMaxMs,
      rangeLatencyTail: this.rangeLatencyDist.snapshot(),
      mountBurst: this.mountBurstDist.snapshot(),
      jsiCalls: this.jsiCalls,
      batchFlushes: this.batchFlushes,
      batchPairsSum: this.batchPairsSum,
      batchPairsMax: this.batchPairsMax,
      itemMounts: this.itemMounts,
      itemUnmounts: this.itemUnmounts,
      itemRenders: this.itemRenders,
      itemContentRenders: this.itemContentRenders,
      firstRangeLatencyMs: this.firstRangeLatencyMs,
      scrollToIndexStarts: this.scrollToIndexStarts,
      scrollToIndexCompletions: this.scrollToIndexCompletions,
      lastScrollToIndex: this.lastScrollToIndex,
      flingPrewarmOutcomes: this.flingPrewarmOutcomes,
      flingPrewarmMisses: this.flingPrewarmMisses,
      layoutVersionBumps: this.layoutVersionBumps,
    };
  }
}

export const NitroListPerfMonitor = new NitroListPerfMonitorImpl();
