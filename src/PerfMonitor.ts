/**
 * Performance monitor for NitroList — dev-only by default, opt-in for
 * release benchmark builds.
 *
 * Every call site inside NitroList.tsx is gated on `NITRO_LIST_PERF_COMPILED`
 * below: `__DEV__` (normal dev flow) or the `EXPO_PUBLIC_NITRO_BENCH=1`
 * build-time env var, which keeps the monitor compiled inside a REAL release
 * build — the only honest way to measure release-mode JS on device.
 * Ordinary release builds (env unset) keep paying just one boolean check per
 * hook; every record method also early-returns when `enabled` is false.
 *
 * Metric definitions:
 * - blank px: on each scroll event, the visible viewport interval is compared
 *   against the interval covered by the currently *mounted* range. Pixels of
 *   viewport not covered by mounted cells count as blank. This mirrors
 *   FlashList's blank-area metric and is the primary fast-scroll health
 *   signal for a JS-driven virtualizer.
 * - batch pairs: number of (index, size) pairs per `setItemSizesBatch` flush.
 *   During a fling over unmeasured content this should be ~the engaged window
 *   size; values of 1-2 mean the rAF batching is fragmenting and each frame
 *   pays multiple native roundtrips.
 * - item mounts/unmounts: cell containers entering/leaving the React tree.
 *   Any future recycling decision hinges on this rate under fling on a
 *   low-end device (profile before recycling).
 * - first range latency: max(component mount, last reset()) → first non-empty
 *   native range. Time-to-first-item proxy on a real screen; scripted runs
 *   reset() at start, so the anchor is the run start, not the button press.
 * - range latency: `setScrollOffset` dispatch → the `onRangeChange` callback
 *   it triggered landing back on the JS thread. Measures the async-callback
 *   hop that the synchronous `setScrollOffsetAndFill` path avoids.
 * - jsi calls: JSI crossings initiated by NitroList's hot paths (scroll
 *   dispatch, batch flushes, slab hydrations, layout-cache misses). Divide by
 *   windowMs for calls/s under scroll.
 * - tail percentiles (p50/p95/p99): kept for scroll→range latency and mount
 *   bursts. Averages hide the individual stalls that drop frames — the tail
 *   is what jank feels like.
 * - mount burst: cell containers mounted within a single effect flush (one
 *   React commit). This is the admission-control input for the frame-budget
 *   prewarm scheduler (prewarmAdmission.ts): it says how many mounts a single
 *   tick absorbs today (e.g. an 80-item fling prewarm landing at once).
 */

/**
 * Compile-time-ish gate for all monitor call sites.
 * EXPO_PUBLIC_* vars are inlined by Expo at bundle time, so a release build
 * made with `EXPO_PUBLIC_NITRO_BENCH=1` keeps the instrumentation.
 */
export const NITRO_LIST_PERF_COMPILED = (typeof __DEV__ !== 'undefined' && __DEV__) || process.env.EXPO_PUBLIC_NITRO_BENCH === '1';

export interface NitroListScrollToIndexStats {
  durationMs: number;
  prewarmRestarts: number;
  correctionPasses: number;
  animated: boolean;
}

export interface NitroListPerfSnapshot {
  enabled: boolean;
  /** Milliseconds since enable()/reset(). */
  windowMs: number;
  scrollSamples: number;
  /** Samples where any visible pixel was uncovered by a mounted cell. */
  blankSamples: number;
  blankPxMax: number;
  /** Sum of blank px across samples — a px·events area proxy. */
  blankPxSum: number;
  rangeEvents: number;
  /** Scroll-dispatch → range-callback deltas (only scroll-triggered events). */
  rangeLatencySamples: number;
  rangeLatencySumMs: number;
  rangeLatencyMaxMs: number;
  /** Tail of the same scroll→range latency samples (ms). */
  rangeLatencyTail: LatencyDistributionSnapshot;
  /** Cells mounted per effect flush (≈ per React commit) — R1 budget input. */
  mountBurst: LatencyDistributionSnapshot;
  /** JSI crossings from NitroList hot paths (scroll, batches, slab, cache misses). */
  jsiCalls: number;
  batchFlushes: number;
  batchPairsSum: number;
  batchPairsMax: number;
  itemMounts: number;
  itemUnmounts: number;
  itemRenders: number;
  firstRangeLatencyMs: number | null;
  scrollToIndexStarts: number;
  scrollToIndexCompletions: number;
  lastScrollToIndex: NitroListScrollToIndexStats | null;
}

/** Scroll dispatches older than this cannot be the cause of a range event. */
const RANGE_LATENCY_WINDOW_MS = 200;

export interface LatencyDistributionSnapshot {
  /** Total values recorded (may exceed the stored-sample cap). */
  count: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

const EMPTY_DISTRIBUTION: LatencyDistributionSnapshot = {count: 0, max: 0, p50: 0, p95: 0, p99: 0};

/**
 * Bounded sample buffer with nearest-rank percentiles. Beyond the cap it keeps
 * counting/tracking max but stops storing, so percentiles describe the first
 * 32k samples — a 30s run at 60Hz is ~1.8k and a full sweep ~25k, both inside
 * the cap. Dev-only: the sort in snapshot() runs on demand, never in hot paths.
 */
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
  private readonly rangeLatencyDist = new LatencyDistribution();
  private readonly mountBurstDist = new LatencyDistribution();
  private pendingMountBurst = 0;
  private firstRangeLatencyMs: number | null = null;
  private scrollToIndexStarts = 0;
  private scrollToIndexCompletions = 0;
  private lastScrollToIndex: NitroListScrollToIndexStats | null = null;

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
    this.rangeLatencyDist.reset();
    this.mountBurstDist.reset();
    this.pendingMountBurst = 0;
    this.firstRangeLatencyMs = null;
    this.scrollToIndexStarts = 0;
    this.scrollToIndexCompletions = 0;
    this.lastScrollToIndex = null;
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

  /** Call right before `setScrollOffset` so the next range event can be timed. */
  markScrollDispatch() {
    if (!this.enabled) return;
    this.lastScrollDispatchAt = Date.now();
  }

  /**
   * Discard an armed dispatch mark. The sync path answered the dispatch with
   * "range unchanged", so no async event is coming for it — a later
   * measurement-initiated range event must not consume the mark as if its
   * delta were scroll latency.
   */
  clearScrollDispatchMark() {
    this.lastScrollDispatchAt = 0;
  }

  recordRangeEvent() {
    if (!this.enabled) return;
    this.rangeEvents++;
    const dispatchedAt = this.lastScrollDispatchAt;
    if (dispatchedAt > 0) {
      // Consume the mark either way: a second range event for the same
      // dispatch (e.g. a measurement batch racing in) must not re-count.
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

  /**
   * Mount effects for one React commit flush synchronously, so a microtask
   * scheduled by the first mount sees the whole burst. The burst size is the
   * "how many mounts landed in one tick" number the R1 scheduler will budget.
   */
  recordItemMount() {
    if (!this.enabled) return;
    this.itemMounts++;
    if (this.pendingMountBurst === 0) {
      queueMicrotask(() => {
        // reset()/disable() may have run before the flush — burst is stale then.
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

  /**
   * `anchorTimestampMs` is the component's mount time; the effective anchor
   * is the later of mount and the last reset(), so a run that reset() the
   * monitor measures from the run start instead of the screen mount.
   */
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
      firstRangeLatencyMs: this.firstRangeLatencyMs,
      scrollToIndexStarts: this.scrollToIndexStarts,
      scrollToIndexCompletions: this.scrollToIndexCompletions,
      lastScrollToIndex: this.lastScrollToIndex,
    };
  }
}

export const NitroListPerfMonitor = new NitroListPerfMonitorImpl();
