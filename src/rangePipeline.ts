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
import {flushWaiters, waitForLayoutPass} from './scrollCommands';

type Ref<V> = {current: V};

export interface RangePipelineCtx {
  store: ListStore;
  layout: LayoutCacheApi;
  engineRef: Ref<NitroListEngine | null>;
  itemCountRef: Ref<number>;
  latestRangeRef: Ref<{start: number; end: number}>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  lastSeenLayoutVersionRef: Ref<number>;
  lastPushedEngineOffsetRef: Ref<number | null>;
  lastLiveEngineOffsetRef: Ref<number>;
  deferredLiveRangeRef: Ref<{
    start: number;
    end: number;
    version: number;
    engineOffset: number;
  } | null>;
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
  noteLayoutVersion: (version: number) => void;
  applyPrewarmRange: (start: number, end: number, version: number) => void;
  commitLiveRange: (
    start: number,
    end: number,
    version: number,
    engineOffset: number,
  ) => void;
  flushDeferredLiveRange: () => void;
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
  const noteLayoutVersion = (version: number): void => {
    if (version === ctx.lastSeenLayoutVersionRef.current) return;
    ctx.lastSeenLayoutVersionRef.current = version;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordLayoutVersionBump();
    ctx.invalidateLayoutCache();
    ctx.store.set('totalSize', ctx.readTotalSizeRef.current());
    ctx.checkEdgeCallbacksRef.current();
  };

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

  const commitLiveRange = (start: number, end: number, version: number, engineOffset: number): void => {
    if (ctx.scrollActivityRef.current.programmaticAnimated) {
      ctx.deferredLiveRangeRef.current = {start, end, version, engineOffset};
      return;
    }
    ctx.deferredLiveRangeRef.current = null;
    const direction = engineOffset - ctx.lastLiveEngineOffsetRef.current;
    ctx.lastLiveEngineOffsetRef.current = engineOffset;
    const raw: AdmissionRange = {start, end};
    const stable = NitroListDevFlags.rangeEdgeHysteresis
      ? stabilizeRange(raw, ctx.latestRangeRef.current, direction, ctx.itemCountRef.current)
      : raw;
    ctx.latestRangeRef.current = stable;
    ctx.setRangeTracked({start: stable.start, end: stable.end, layoutVersion: version});
  };

  const flushDeferredLiveRange = (): void => {
  const deferred = ctx.deferredLiveRangeRef.current;
  if (deferred == null) return;
  commitLiveRange(deferred.start, deferred.end, deferred.version, deferred.engineOffset);
  };

  const handleRangeChange = (start: number, end: number, layoutVersion: number, engineOffset: number): void => {
    const filled = ctx.fillSlab(start, end);
    let eventStart = start;
    let eventEnd = end;
    let eventVersion = layoutVersion;
    let eventOffset = engineOffset;
    if (
      filled != null &&
      NitroListDevFlags.staleRangeReconcile &&
      !ctx.uiThreadDriverActiveRef.current
    ) {
      eventVersion = filled.slab[0] | 0;
      eventStart = filled.slab[2] | 0;
      eventEnd = filled.slab[3] | 0;
      const pushed = ctx.lastPushedEngineOffsetRef.current;
      if (pushed != null) eventOffset = pushed;
    }
    if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
      NitroListPerfMonitor.recordRangeEvent();
      if (eventEnd >= eventStart) {
        NitroListPerfMonitor.recordFirstRange(ctx.mountTimestampRef.current);
      }
    }
    const uiDriven = ctx.uiThreadDriverActiveRef.current && !ctx.isPrewarmingRangeRef.current;
    let offsetConsumed = false;
    if (uiDriven) {
      ctx.lastScrollOffsetRef.current = engineOffset + ctx.effectivePaddingStartRef.current;
      offsetConsumed = true;
      if (ctx.scrollActivityRef.current.programmaticAnimated) {
        ctx.programmaticAnimatedScrollSeenRef.current = true;
      }
    }
    noteLayoutVersion(eventVersion);
    if (filled != null) ctx.writeSlabToCache(filled.slab, filled.written);

    if (ctx.isPrewarmingRangeRef.current) {
      ctx.latestRangeRef.current = {start: eventStart, end: eventEnd};
      applyPrewarmRange(eventStart, eventEnd, eventVersion);
      return;
    }
    commitLiveRange(eventStart, eventEnd, eventVersion, eventOffset);

    if (offsetConsumed) {
      ctx.evaluateViewabilityRef.current();
      ctx.checkEdgeCallbacksRef.current();
      ctx.captureMvcpAnchorRef.current(engineOffset);
      ctx.emitFirstVisibleRef.current();
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        const viewportH = ctx.mainViewportRef.current;
        if (viewportH > 0) {
          const visTop = Math.max(0, engineOffset);
          const visBottom = Math.min(
            engineOffset + viewportH,
            ctx.readTotalSize(),
          );
          if (visBottom > visTop) {
            const mounted = ctx.latestRangeRef.current;
            let blankPx: number;
            if (mounted.end < mounted.start) {
              blankPx = visBottom - visTop;
            } else {
              const coveredTop = ctx.readItemOffset(mounted.start);
              const coveredBottom = ctx.readItemOffset(mounted.end) + ctx.readItemSize(mounted.end);
              blankPx =
                Math.max(0, coveredTop - visTop) + Math.max(0, visBottom - coveredBottom);
            }
            NitroListPerfMonitor.recordScrollSample(blankPx);
          }
        }
      }
    }
  };

  const applyScrollOffsetSync = (engineOffset: number): void => {
    const hybrid = ctx.engineRef.current;
    if (!hybrid) return;
    let slab = ctx.layout.getSlab();
    let written = hybrid.setScrollOffsetAndFill(engineOffset, slab.buffer);
    ctx.lastPushedEngineOffsetRef.current = engineOffset;
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    if (written < 0) {
      slab = ctx.layout.growSlab();
      written = hybrid.setScrollOffsetAndFill(engineOffset, slab.buffer);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) return;
    }
    if (written === 0) {
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.clearScrollDispatchMark();
      return;
    }
    const version = slab[0] | 0;
    const start = slab[2] | 0;
    const end = slab[3] | 0;
    if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
      NitroListPerfMonitor.recordRangeEvent();
      if (end >= start) {
        NitroListPerfMonitor.recordFirstRange(ctx.mountTimestampRef.current);
      }
    }
    noteLayoutVersion(version);
    ctx.writeSlabToCache(slab, written);
    if (ctx.isPrewarmingRangeRef.current) {
      ctx.latestRangeRef.current = {start, end};
      applyPrewarmRange(start, end, version);
      return;
    }
    commitLiveRange(start, end, version, engineOffset);
  };

  const resyncPrewarmFromEngine = (): void => {
  if (!ctx.isPrewarmingRangeRef.current) return;
  const latest = ctx.latestRangeRef.current;
  const filled = ctx.fillSlab(latest.start, latest.end);
  if (filled == null) return;
  const version = filled.slab[0] | 0;
  const start = filled.slab[2] | 0;
  const end = filled.slab[3] | 0;
  noteLayoutVersion(version);
  ctx.writeSlabToCache(filled.slab, filled.written);
  if (end < start) return;
  ctx.latestRangeRef.current = {start, end};
  ctx.lastPrewarmRangeRef.current = {start, end, layoutVersion: version};
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
      const by = await Promise.race([
        new Promise<'evt'>((resolve) => ctx.commitWaitersRef.current.push(() => resolve('evt'))),
        waitForLayoutPass().then(() => 'raf' as const),
      ]);
      if (trace) trace.push(`commit:${by} ${Date.now() - t}`);
    } else if (trace) {
      trace.push('commit:skip');
    }
    const awaiting = ctx.cellBridgeRef.current.awaitingLayout;
    if (awaiting > 0) {
      const t = trace ? Date.now() : 0;
      const by = await Promise.race([
        new Promise<'evt'>((resolve) => ctx.layoutSettleWaitersRef.current.push(() => resolve('evt'))),
        waitForLayoutPass().then(() => 'raf' as const),
      ]);
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
    noteLayoutVersion,
    applyPrewarmRange,
    commitLiveRange,
    flushDeferredLiveRange,
    handleRangeChange,
    applyScrollOffsetSync,
    resyncPrewarmFromEngine,
    waitForLayoutSettle,
  };
}
