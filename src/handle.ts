import type {ScrollView} from 'react-native';

import type {
  NitroListHandle,
  NitroListScrollToIndexParams,
  NitroListScrollToOffsetParams,
} from './NitroList';
import type {NitroListEngine} from './NitroListEngine.nitro';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';

type Ref<V> = {current: V};
export type ItemTypeKey = string | number;
type RangeState = {start: number; end: number; layoutVersion: number};

export interface HandleCtx<T> {
  items: ReadonlyArray<T>;
  itemCount: number;
  keyExtractor?: (item: T, index: number) => string;
  effectivePaddingStart: number;
  engineRef: Ref<NitroListEngine | null>;
  scrollRef: Ref<ScrollView | null>;
  typeIdMapRef: Ref<Map<ItemTypeKey, number>>;
  viewportSizeRef: Ref<{width: number; height: number}>;
  crossViewportRef: Ref<number>;
  isHorizontalRef: Ref<boolean>;
  lastScrollOffsetRef: Ref<number>;
  contentInsetBottomRef: Ref<number>;
  isPrewarmingRangeRef: Ref<boolean>;
  lastPrewarmRangeRef: Ref<RangeState | null>;
  animatedScrollResolverRef: Ref<(() => void) | null>;
  checkEdgeCallbacksRef: Ref<() => void>;
  readItemOffset: (index: number) => number;
  readItemSize: (index: number) => number;
  readTotalSize: () => number;
  beginScrollCommand: () => number;
  trackScrollCommand: (commandId: number) => Promise<void>;
  resolveScrollCommand: (commandId: number) => void;
  cancelFlingPrewarm: () => void;
  setPrewarmRangeTracked: (next: RangeState | null) => void;
  scrollToAbsoluteOffset: (offset: number, animated: boolean) => number;
  scrollToIndexPrecisely: (params: NitroListScrollToIndexParams) => Promise<void>;
  scrollToEndPrecisely: (animated: boolean) => Promise<void>;
  scrollIndexIntoViewImpl: (
    index: number,
    animated: boolean,
    viewOffset: number,
  ) => Promise<void>;
}

export function createNitroListHandle<T>(ctx: HandleCtx<T>): NitroListHandle {
  return {
    scrollToOffset({offset, animated = false}: NitroListScrollToOffsetParams) {
      const commandId = ctx.beginScrollCommand();
      ctx.isPrewarmingRangeRef.current = false;
      ctx.lastPrewarmRangeRef.current = null;
      ctx.cancelFlingPrewarm();
      ctx.setPrewarmRangeTracked(null);
      ctx.scrollToAbsoluteOffset(offset, animated);
      const promise = ctx.trackScrollCommand(commandId);
      if (animated) {
        ctx.animatedScrollResolverRef.current = () => ctx.resolveScrollCommand(commandId);
      } else {
        requestAnimationFrame(() => ctx.resolveScrollCommand(commandId));
      }
      return promise;
    },
    scrollToIndex({
      index,
      animated = false,
      viewPosition = 0,
      viewOffset = 0,
    }: NitroListScrollToIndexParams) {
      return ctx.scrollToIndexPrecisely({index, animated, viewPosition, viewOffset});
    },
    scrollToEnd(animated = false) {
      ctx.isPrewarmingRangeRef.current = false;
      ctx.lastPrewarmRangeRef.current = null;
      ctx.cancelFlingPrewarm();
      ctx.setPrewarmRangeTracked(null);
      return ctx.scrollToEndPrecisely(animated);
    },
    getAbsoluteLastScrollOffset() {
      return ctx.lastScrollOffsetRef.current;
    },
    getItemOffset(index: number) {
      return ctx.readItemOffset(index);
    },
    getItemSize(index: number) {
      return ctx.readItemSize(index);
    },
    getTotalSize() {
      return ctx.readTotalSize();
    },
    getLayout(index: number) {
      if (index < 0 || index >= ctx.itemCount) return undefined;
      const offset = ctx.readItemOffset(index);
      const size = ctx.readItemSize(index);
      if (ctx.isHorizontalRef.current) {
        return {x: offset, y: 0, width: size, height: ctx.crossViewportRef.current};
      }
      return {x: 0, y: offset, width: ctx.crossViewportRef.current, height: size};
    },
    getWindowSize() {
      return {
        width: ctx.viewportSizeRef.current.width,
        height: ctx.viewportSizeRef.current.height,
      };
    },
    getFirstItemOffset() {
      return ctx.effectivePaddingStart;
    },
    getScrollableNode() {
      const node = ctx.scrollRef.current as
        | (ScrollView & {getScrollableNode?: () => unknown})
        | null;
      return node?.getScrollableNode != null ? node.getScrollableNode() : null;
    },
    getNativeScrollRef() {
      const node = ctx.scrollRef.current as
        | (ScrollView & {getNativeScrollRef?: () => unknown})
        | null;
      return node?.getNativeScrollRef != null ? node.getNativeScrollRef() : node;
    },
    scrollIndexIntoView({
      index,
      animated = false,
      viewOffset = 0,
    }: {
      index: number;
      animated?: boolean;
      viewOffset?: number;
    }) {
      return ctx.scrollIndexIntoViewImpl(index, animated, viewOffset);
    },
    scrollItemIntoView({
      item,
      animated = false,
      viewOffset = 0,
    }: {
      item: unknown;
      animated?: boolean;
      viewOffset?: number;
    }) {
      let index = (ctx.items as ReadonlyArray<unknown>).indexOf(item);
      if (index < 0 && ctx.keyExtractor != null && item != null) {
        const wantedKey = ctx.keyExtractor(item as T, 0);
        for (let i = 0; i < ctx.itemCount; i++) {
          if (ctx.keyExtractor(ctx.items[i], i) === wantedKey) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) return Promise.resolve();
      return ctx.scrollIndexIntoViewImpl(index, animated, viewOffset);
    },
    reportContentInset({bottom = 0}: {bottom?: number}) {
      const next = Number.isFinite(bottom) ? Math.max(0, bottom) : 0;
      if (next === ctx.contentInsetBottomRef.current) return;
      ctx.contentInsetBottomRef.current = next;
      ctx.checkEdgeCallbacksRef.current();
    },
    getAverageItemSizes() {
      const result: Record<string, {average: number; count: number}> = {};
      const hybrid = ctx.engineRef.current;
      if (hybrid == null) return result;
      let stats = new Float64Array((ctx.typeIdMapRef.current.size + 2) * 3);
      let written = hybrid.fillTypeStats(stats.buffer);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) {
        stats = new Float64Array(4096 * 3);
        written = hybrid.fillTypeStats(stats.buffer);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        if (written < 0) return result;
      }
      const idToType = new Map<number, ItemTypeKey>();
      for (const [type, id] of ctx.typeIdMapRef.current) idToType.set(id, type);
      for (let k = 0; k < written; k++) {
        const id = stats[k * 3] | 0;
        const label = id === 0 ? '' : String(idToType.get(id) ?? id);
        result[label] = {average: stats[k * 3 + 1], count: stats[k * 3 + 2]};
      }
      return result;
    },
  };
}
