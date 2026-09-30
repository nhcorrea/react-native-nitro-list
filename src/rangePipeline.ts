import {validSnapshot} from './layoutSnapshot';
import type {CellBridge} from './cells';
import {NitroListDevFlags} from './devFlags';
import type {LayoutCacheApi} from './layoutCache';
import type {ListStore, RangeState} from './listStore';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import {
  growAdmittedRange,
  PREWARM_ADMISSION_BUDGET_ITEMS,
  rangeCovers,
  type AdmissionRange,
} from './prewarmAdmission';
import {stabilizeRange} from './rangeHysteresis';
import {flushWaiters, waitForEventOrLayoutPass, waitForLayoutPass} from './scrollCommands';

type Ref<V> = {current: V};

export interface RangePipelineCtx {
  dataRevisionRef: Ref<number>;
  store: ListStore;
  layout: LayoutCacheApi;
  engineRef: Ref<NitroListEngine | null>;
  itemCountRef: Ref<number>;
  latestRangeRef: Ref<{start: number; end: number}>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  lastSeenLayoutVersionRef: Ref<number>;
  lastPushedEngineOffsetRef: Ref<number | null>;
  lastLiveEngineOffsetRef: Ref<number>;
  isPrewarmingRangeRef: Ref<boolean>;
  uiThreadDriverActiveRef: Ref<boolean>;
  prewarmFocusRef: Ref<{focus: {start: number; end: number}; direction: 1 | -1} | null>;
  prewarmAdmissionRef: Ref<{
    target: AdmissionRange;
    focus: AdmissionRange;
    admitted: AdmissionRange | null;
    direction: 1 | -1;
    version: number;
    rafId: number | null;
    waiters: Array<() => void>;
  } | null>;
  prewarmStateRef: Ref<RangeState | null>;
  pendingCommitRef: Ref<number>;
  readTotalSize: () => number;
  scrollActivityRef: Ref<{programmaticAnimated: boolean}>;
  programmaticAnimatedScrollSeenRef: Ref<boolean>;
  effectivePaddingStartRef: Ref<number>;
  lastScrollOffsetRef: Ref<number>;
  mainViewportRef: Ref<number>;
  mountTimestampRef: Ref<number>;
  layoutSettleWaitersRef: Ref<Array<() => void>>;
  commitWaitersRef: Ref<Array<() => void>>;
  commitCounterRef: Ref<number>;
  pendingSizesRef: Ref<{count: number}>;
  cellBridgeRef: Ref<CellBridge>;
  checkEdgeCallbacksRef: Ref<() => void>;
  captureMvcpAnchorRef: Ref<(engineOffset: number) => void>;
  evaluateViewabilityRef: Ref<() => void>;
  emitFirstVisibleRef: Ref<() => void>;
  readTotalSizeRef: Ref<() => number>;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  invalidateLayoutCache: () => void;
  fillSlab: (
    expectedStart: number,
    expectedEnd: number,
  ) => {slab: Float64Array; written: number} | null;
  writeSlabToCache: (slab: Float64Array, written: number) => void;
  setRangeTracked: (next: RangeState) => void;
  setPrewarmRangeTracked: (next: RangeState | null) => void;
  cancelPrewarmAdmission: () => void;
  flushPendingItemSizes: (emitRange?: boolean) => void;
}

export interface RangePipelineApi {
  consumeSnapshot: (slab: Float64Array, written: number, commitRange?: boolean) => boolean;
  applyPrewarmRange: (start: number, end: number, version: number) => void;
  commitLiveRange: (start: number, end: number, version: number, engineOffset: number) => void;
  handleRangeChange: (
    start: number,
    end: number,
    layoutVersion: number,
    engineOffset: number,
  ) => void;
  applyScrollOffsetSync: (engineOffset: number) => void;
  resyncPrewarmFromEngine: () => void;
  waitForLayoutSettle: (trace?: string[]) => Promise<void>;
}

export function createRangePipeline(ctx: RangePipelineCtx): RangePipelineApi {
  const applyPrewarmRange = (start: number, end: number, version: number): void => {
    ctx.lastPrewarmRangeRef.current = {start, end, layoutVersion: version};
    const focusInfo = ctx.prewarmFocusRef.current;
    const count = end - start + 1;
    if (
      !NitroListDevFlags.stiLandingAdmission ||
      focusInfo == null ||
      count <= PREWARM_ADMISSION_BUDGET_ITEMS
    ) {
      ctx.cancelPrewarmAdmission();
      ctx.setPrewarmRangeTracked({start, end, layoutVersion: version});
      return;
    }
    const current = ctx.prewarmAdmissionRef.current;
    if (current != null && current.target.start === start && current.target.end === end) {
      current.version = version;
      if (current.admitted != null) {
        ctx.setPrewarmRangeTracked({
          start: current.admitted.start,
          end: current.admitted.end,
          layoutVersion: version,
        });
      }
      return;
    }
    const carried = current != null ? current.admitted : ctx.prewarmStateRef.current;
    ctx.cancelPrewarmAdmission();
    let seed: AdmissionRange | null = null;
    if (carried != null) {
      const seedStart = Math.max(carried.start, start);
      const seedEnd = Math.min(carried.end, end);
      if (seedEnd >= seedStart) seed = {start: seedStart, end: seedEnd};
    }
    const admission: NonNullable<typeof ctx.prewarmAdmissionRef.current> = {
      target: {start, end},
      focus: focusInfo.focus,
      admitted: seed,
      direction: focusInfo.direction,
      version,
      rafId: null,
      waiters: [],
    };
    ctx.prewarmAdmissionRef.current = admission;
    const admitSlice = () => {
      if (ctx.prewarmAdmissionRef.current !== admission) return;
      admission.admitted = growAdmittedRange(
        admission.target,
        admission.focus,
        admission.admitted,
        PREWARM_ADMISSION_BUDGET_ITEMS,
        admission.direction,
      );
      ctx.setPrewarmRangeTracked({
        start: admission.admitted.start,
        end: admission.admitted.end,
        layoutVersion: admission.version,
      });
      if (rangeCovers(admission.admitted, admission.target)) {
        admission.rafId = null;
        ctx.prewarmAdmissionRef.current = null;
        flushWaiters(admission.waiters);
        return;
      }
      admission.rafId = requestAnimationFrame(admitSlice);
    };
    admitSlice();
  };

  const commitLiveRange = (
    start: number,
    end: number,
    version: number,
    engineOffset: number,
  ): void => {
    // Destination prewarm is additional content. The native animation still
    // needs the live window at every intermediate offset.
    const direction = engineOffset - ctx.lastLiveEngineOffsetRef.current;
    ctx.lastLiveEngineOffsetRef.current = engineOffset;
    const latest = ctx.latestRangeRef.current;
    let stable: AdmissionRange = latest;
    if (latest.start !== start || latest.end !== end) {
      const raw: AdmissionRange = {start, end};
      stable = NitroListDevFlags.rangeEdgeHysteresis
        ? stabilizeRange(raw, latest, direction, ctx.itemCountRef.current)
        : raw;
      ctx.latestRangeRef.current = stable;
    }
    const tracked = ctx.store.get('range');
    if (tracked.start === stable.start && tracked.end === stable.end && tracked.layoutVersion === version) {
      return;
    }
    ctx.setRangeTracked({start: stable.start, end: stable.end, layoutVersion: version});
  };

  let lastSequence = -1;
  let lastDataRevision = -1;
  let sequenceEngine: NitroListEngine | null = null;
  const consumeSnapshot = (slab: Float64Array, written: number, commitRange = true): boolean => {
    if (!validSnapshot(slab, written) || slab[6] !== ctx.dataRevisionRef.current) return false;
    if (sequenceEngine !== ctx.engineRef.current) {
      sequenceEngine = ctx.engineRef.current;
      lastSequence = -1;
      lastDataRevision = -1;
    }
    if (slab[7] <= lastSequence) return false;
    lastSequence = slab[7];
    const version = slab[0],
      start = slab[2],
      end = slab[3],
      offset = slab[8];
    const versionChanged = version !== ctx.lastSeenLayoutVersionRef.current;
    const rangeChanged =
      start !== ctx.latestRangeRef.current.start || end !== ctx.latestRangeRef.current.end;
    if (commitRange && (versionChanged || rangeChanged) && NITRO_LIST_PERF_COMPILED) {
      NitroListPerfMonitor.recordRangeEvent();
      if (end >= start) NitroListPerfMonitor.recordFirstRange(ctx.mountTimestampRef.current);
    }
    if (versionChanged) {
      ctx.lastSeenLayoutVersionRef.current = version;
      ctx.invalidateLayoutCache();
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordLayoutVersionBump();
    }
    if (ctx.uiThreadDriverActiveRef.current && !ctx.isPrewarmingRangeRef.current) {
      ctx.lastScrollOffsetRef.current = offset + ctx.effectivePaddingStartRef.current;
      if (ctx.scrollActivityRef.current.programmaticAnimated)
        ctx.programmaticAnimatedScrollSeenRef.current = true;
    }
    // Publish the complete geometry before callbacks can read it or reenter.
    if (
      versionChanged ||
      rangeChanged ||
      lastDataRevision !== slab[6] ||
      !ctx.layout.hasCurrentSnapshot()
    ) {
      ctx.writeSlabToCache(slab, written);
      ctx.store.set('totalSize', slab[1]);
    }
    lastDataRevision = slab[6];
    if (commitRange) {
      if (ctx.isPrewarmingRangeRef.current) {
        ctx.latestRangeRef.current = {start, end};
        applyPrewarmRange(start, end, version);
      } else commitLiveRange(start, end, version, offset);
    }
    if (versionChanged) ctx.checkEdgeCallbacksRef.current();
    return true;
  };

  const handleRangeChange = (
    start: number,
    end: number,
    _version: number,
    _offset: number,
  ): void => {
    // Async events are invalidation hints. Their offset/range can already be obsolete.
    const filled = ctx.fillSlab(start, end);
    if (filled == null) return;
    const offset = filled.slab[8];
    if (!consumeSnapshot(filled.slab, filled.written)) return;
    if (ctx.uiThreadDriverActiveRef.current && !ctx.isPrewarmingRangeRef.current) {
      ctx.lastScrollOffsetRef.current = offset + ctx.effectivePaddingStartRef.current;
      if (ctx.scrollActivityRef.current.programmaticAnimated)
        ctx.programmaticAnimatedScrollSeenRef.current = true;
      ctx.evaluateViewabilityRef.current();
      ctx.checkEdgeCallbacksRef.current();
      ctx.captureMvcpAnchorRef.current(offset);
      ctx.emitFirstVisibleRef.current();
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        const viewport = ctx.mainViewportRef.current;
        const visibleTop = Math.max(0, offset);
        const visibleBottom = Math.min(offset + viewport, ctx.readTotalSize());
        if (viewport > 0 && visibleBottom > visibleTop) {
          const mounted = ctx.latestRangeRef.current;
          const blank =
            mounted.end < mounted.start
              ? visibleBottom - visibleTop
              : Math.max(0, ctx.readItemOffset(mounted.start) - visibleTop) +
                Math.max(
                  0,
                  visibleBottom - ctx.readItemOffset(mounted.end) - ctx.readItemSize(mounted.end),
                );
          NitroListPerfMonitor.recordScrollSample(blank);
        }
      }
    }
  };

  const applyScrollOffsetSync = (engineOffset: number): void => {
    const hybrid = ctx.engineRef.current;
    if (!hybrid) return;
    const written = hybrid.setScrollOffsetAndFill(engineOffset, ctx.layout.getSlab().buffer);
    ctx.lastPushedEngineOffsetRef.current = engineOffset;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    const filled = ctx.layout.completeSnapshot(written);
    if (filled != null) consumeSnapshot(filled.slab, filled.written);
  };

  const resyncPrewarmFromEngine = (): void => {
    if (!ctx.isPrewarmingRangeRef.current) return;
    const latest = ctx.latestRangeRef.current;
    const filled = ctx.fillSlab(latest.start, latest.end);
    if (filled == null) return;
    consumeSnapshot(filled.slab, filled.written);
  };

  const waitForLayoutSettle = async (trace?: string[]): Promise<void> => {
    if (!NitroListDevFlags.stiEventDrivenWait) {
      await waitForLayoutPass();
      return;
    }
    const admission = ctx.prewarmAdmissionRef.current;
    if (admission != null && admission.rafId != null) {
      const t = trace ? Date.now() : 0;
      await new Promise<void>((resolve) => admission.waiters.push(resolve));
      if (trace) trace.push(`adm ${Date.now() - t}`);
    }
    if (ctx.commitCounterRef.current < ctx.pendingCommitRef.current) {
      const t = trace ? Date.now() : 0;
      const by = await waitForEventOrLayoutPass(ctx.commitWaitersRef.current);
      if (trace) trace.push(`commit:${by} ${Date.now() - t}`);
    } else if (trace) {
      trace.push('commit:skip');
    }
    const awaiting = ctx.cellBridgeRef.current.awaitingLayout;
    if (awaiting > 0) {
      const t = trace ? Date.now() : 0;
      const by = await waitForEventOrLayoutPass(ctx.layoutSettleWaitersRef.current);
      if (trace) trace.push(`layout(${awaiting}):${by} ${Date.now() - t}`);
    } else if (trace) {
      trace.push('layout:skip');
    }
    const pendingSizes = ctx.pendingSizesRef.current.count;
    if (pendingSizes > 0) ctx.flushPendingItemSizes();
    if (trace) trace.push(`flush ${pendingSizes}`);
    resyncPrewarmFromEngine();
  };
  return {
    consumeSnapshot,
    applyPrewarmRange,
    commitLiveRange,
    handleRangeChange,
    applyScrollOffsetSync,
    resyncPrewarmFromEngine,
    waitForLayoutSettle,
  };
}
