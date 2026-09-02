import {
  buildKeyRemapPairs,
  didKeysChangeStructurally,
  REMAP_MIN_MAPPED_FRACTION,
} from './keyRemap';
import {maybeWarnMissingKeyExtractor} from './devWarnings';
import {MVCP_POSITION_EPSILON} from './measurement';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import type {ViewToken} from './viewability';

type Ref<V> = {current: V};
type RangeState = {start: number; end: number; layoutVersion: number};

export interface DataChangeCtx<T> {
  items: ReadonlyArray<T>;
  dataVersion: unknown;
  keyExtractor?: (item: T, index: number) => string;
  previousItemsRef: Ref<ReadonlyArray<T>>;
  previousDataVersionRef: Ref<unknown>;
  dataJustChangedRef: Ref<boolean>;
  engineRef: Ref<NitroListEngine | null>;
  mvcpStateRef: Ref<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>;
  mvcpResolvedRef: Ref<{size: boolean; data: boolean}>;
  applyMvcpCorrectionRef: Ref<(diff: number) => void>;
  viewableRef: Ref<Map<number, ViewToken<T>>>;
  pendingRef: Ref<Map<number, number>>;
  isPrewarmingRangeRef: Ref<boolean>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  lastViewabilityEvalRef: Ref<{
    offset: number;
    start: number;
    end: number;
    layoutVersion: number;
  }>;
  viewabilityTimerRef: Ref<ReturnType<typeof setTimeout> | null>;
  cancelFlingPrewarm: () => void;
  setPrewarmRangeTracked: (next: RangeState | null) => void;
  invalidateLayoutCache: () => void;
  readItemOffset: (index: number) => number;
  evaluateViewability: () => void;
}

export function createDataChangeHandler<T>(ctx: DataChangeCtx<T>): () => void {
  return function onDataMaybeChanged(): void {
  const versionChanged = !Object.is(ctx.previousDataVersionRef.current, ctx.dataVersion);
  if (ctx.previousItemsRef.current !== ctx.items || versionChanged) {
    ctx.dataJustChangedRef.current = true;
    const prevItems = ctx.previousItemsRef.current;
    ctx.previousItemsRef.current = ctx.items;
    ctx.previousDataVersionRef.current = ctx.dataVersion;
    const keysChanged = ctx.keyExtractor
      ? didKeysChangeStructurally(prevItems, ctx.items, ctx.keyExtractor)
      : true;
    if (versionChanged || keysChanged) {
      if (!versionChanged) {
        maybeWarnMissingKeyExtractor(ctx.keyExtractor != null, prevItems.length, ctx.items.length);
      }
      const mvcpAnchorBefore =
        ctx.mvcpStateRef.current.enabled && ctx.mvcpResolvedRef.current.data && ctx.keyExtractor != null
          ? ctx.mvcpStateRef.current.anchor
          : null;
      if (ctx.engineRef.current != null && (versionChanged || ctx.keyExtractor)) {
        let remapped = false;
        if (!versionChanged && ctx.keyExtractor != null && ctx.items.length > 0) {
          const remap = buildKeyRemapPairs(prevItems, ctx.items, ctx.keyExtractor);
          if (NITRO_LIST_PERF_COMPILED) {
            NitroListPerfMonitor.recordUserCallbacks(prevItems.length + ctx.items.length);
          }
          if (remap != null && remap.mappedCount >= ctx.items.length * REMAP_MIN_MAPPED_FRACTION) {
            ctx.engineRef.current.remapItemSizes(remap.pairs.buffer as ArrayBuffer);
            remapped = true;
          }
        }
        if (!remapped) {
          ctx.engineRef.current.resetItemSizes();
        }
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
      if (mvcpAnchorBefore != null && mvcpAnchorBefore.key != null && ctx.keyExtractor) {
        let newIndex = -1;
        const sameIndexItem = ctx.items[mvcpAnchorBefore.index];
        if (
          sameIndexItem !== undefined &&
          ctx.keyExtractor(sameIndexItem, mvcpAnchorBefore.index) === mvcpAnchorBefore.key
        ) {
          newIndex = mvcpAnchorBefore.index;
        } else {
          for (let i = 0; i < ctx.items.length; i++) {
            if (ctx.keyExtractor(ctx.items[i], i) === mvcpAnchorBefore.key) {
              newIndex = i;
              break;
            }
          }
        }
        if (newIndex >= 0) {
          ctx.invalidateLayoutCache();
          const offsetAfter = ctx.readItemOffset(newIndex);
          const diff = offsetAfter - mvcpAnchorBefore.offset;
          ctx.mvcpStateRef.current.anchor = {
            index: newIndex,
            key: mvcpAnchorBefore.key,
            offset: mvcpAnchorBefore.offset,
          };
          if (Math.abs(diff) > MVCP_POSITION_EPSILON) {
            ctx.applyMvcpCorrectionRef.current(diff);
          } else {
            ctx.mvcpStateRef.current.anchor.offset = offsetAfter;
          }
        } else {
          ctx.mvcpStateRef.current.anchor = null;
        }
      }
      ctx.viewableRef.current = new Map();
      ctx.pendingRef.current = new Map();
      ctx.isPrewarmingRangeRef.current = false;
      ctx.lastPrewarmRangeRef.current = null;
      ctx.cancelFlingPrewarm();
      ctx.setPrewarmRangeTracked(null);
      ctx.invalidateLayoutCache();
      ctx.lastViewabilityEvalRef.current = {
        offset: Number.NaN,
        start: -1,
        end: -2,
        layoutVersion: -1,
      };
      if (ctx.viewabilityTimerRef.current != null) {
        clearTimeout(ctx.viewabilityTimerRef.current);
        ctx.viewabilityTimerRef.current = null;
      }
    } else {
      const viewable = ctx.viewableRef.current;
      for (const [idx, tok] of viewable) {
        const item = ctx.items[idx];
        if (item !== undefined && tok.item !== item) {
          viewable.set(idx, {...tok, item});
        }
      }
    }
  }
    ctx.evaluateViewability();
  };
}
