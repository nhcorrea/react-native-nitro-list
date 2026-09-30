import type {DataAnalysis} from './dataAnalysis';
import {
  buildKeyRemapPairs,
  REMAP_MIN_MAPPED_FRACTION,
  type KeyRemapAnchor,
  type KeyRemapPairs,
} from './keyRemap';
import {maybeWarnMissingKeyExtractor} from './devWarnings';
import {MVCP_POSITION_EPSILON} from './measurement';
import {nativeFloat64Array} from './nativeBuffers';
import type {NitroListEngine} from './NitroListEngine.nitro';
import type {ViewToken} from './viewability';

type Ref<V> = {current: V};
type RangeState = {start: number; end: number; layoutVersion: number};

export interface DataChangeCtx<T> {
  commitData: (
    remap: KeyRemapPairs | null,
    reset: boolean,
    invalidateFrom: number,
    previous?: ReadonlyArray<T>,
  ) => void;
  analysis: DataAnalysis;
  items: ReadonlyArray<T>;
  dataVersion: unknown;
  keyExtractor?: (item: T, index: number) => string;
  itemsAreEqual?: (previous: T, next: T, index: number) => boolean;
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

function findAnchorIndex<T>(
  items: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
  anchor: KeyRemapAnchor,
): number {
  const sameIndexItem = items[anchor.index];
  if (sameIndexItem !== undefined && keyExtractor(sameIndexItem, anchor.index) === anchor.key) {
    return anchor.index;
  }
  for (let i = 0; i < items.length; i++) {
    if (keyExtractor(items[i], i) === anchor.key) return i;
  }
  return -1;
}

export function createDataChangeHandler<T>(ctx: DataChangeCtx<T>): () => void {
  let remapBuffer: Float64Array<ArrayBuffer> | null = null;
  const allocateRemapPairs = (length: number): Float64Array<ArrayBuffer> => {
    if (remapBuffer == null || remapBuffer.length < length || remapBuffer.length > Math.max(256, length * 4)) {
      remapBuffer = nativeFloat64Array(Math.max(256, length));
    }
    return remapBuffer;
  };
  return function onDataMaybeChanged(): void {
    const versionChanged = !Object.is(ctx.previousDataVersionRef.current, ctx.dataVersion);
    let committed = false;
    if (ctx.previousItemsRef.current !== ctx.items || versionChanged) {
      ctx.dataJustChangedRef.current = true;
      const prevItems = ctx.previousItemsRef.current;
      ctx.previousItemsRef.current = ctx.items;
      ctx.previousDataVersionRef.current = ctx.dataVersion;
      const keysChanged = ctx.analysis.keysChanged;
      if (versionChanged || keysChanged) {
        if (!versionChanged) {
          maybeWarnMissingKeyExtractor(
            ctx.keyExtractor != null,
            prevItems.length,
            ctx.items.length,
          );
        }
        const mvcpAnchorBefore =
          ctx.mvcpStateRef.current.enabled &&
          ctx.mvcpResolvedRef.current.data &&
          ctx.keyExtractor != null
            ? ctx.mvcpStateRef.current.anchor
            : null;
        const anchorRequest: KeyRemapAnchor | null =
          mvcpAnchorBefore != null && mvcpAnchorBefore.key != null
            ? {index: mvcpAnchorBefore.index, key: mvcpAnchorBefore.key}
            : null;
        const anchorOffsetBefore = mvcpAnchorBefore?.offset ?? 0;
        let remapPairs: KeyRemapPairs | null = null;
        let resolvedAnchorIndex: number | null = null;
        if (!versionChanged && ctx.keyExtractor != null && ctx.items.length > 0) {
          const remap = buildKeyRemapPairs(
            prevItems,
            ctx.items,
            ctx.keyExtractor,
            (previous, next, index) =>
              Object.is(previous, next) || ctx.itemsAreEqual?.(previous, next, index) === true,
            anchorRequest,
            allocateRemapPairs,
          );
          if (remap != null) {
            resolvedAnchorIndex = remap.anchorIndex;
            if (remap.mappedCount >= ctx.items.length * REMAP_MIN_MAPPED_FRACTION) {
              remapPairs = remap;
            }
          }
        }
        ctx.commitData(remapPairs, remapPairs == null, ctx.analysis.firstChanged);
        committed = true;
        if (mvcpAnchorBefore != null && anchorRequest != null && ctx.keyExtractor) {
          const newIndex =
            resolvedAnchorIndex ?? findAnchorIndex(ctx.items, ctx.keyExtractor, anchorRequest);
          if (newIndex >= 0) {
            ctx.invalidateLayoutCache();
            const offsetAfter = ctx.readItemOffset(newIndex);
            const diff = offsetAfter - anchorOffsetBefore;
            ctx.mvcpStateRef.current.anchor = {
              index: newIndex,
              key: anchorRequest.key,
              offset: anchorOffsetBefore,
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
        ctx.commitData(null, false, ctx.analysis.firstChanged, prevItems);
        committed = true;
        const viewable = ctx.viewableRef.current;
        for (const [idx, tok] of viewable) {
          const item = ctx.items[idx];
          if (item !== undefined && tok.item !== item) {
            viewable.set(idx, {...tok, item});
          }
        }
      }
    }
    if (!committed) ctx.commitData(null, false, -1);
    ctx.evaluateViewability();
  };
}
