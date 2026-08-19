import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PixelRatio,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type ScrollEvent,
  type ScrollHandlerProcessed,
  type SharedValue,
} from 'react-native-reanimated';
import {scheduleOnRN, scheduleOnUI} from 'react-native-worklets';
import {callback} from 'react-native-nitro-modules';

import {NitroListView, type NitroListViewMethods} from './NitroListHost';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import {
  type AdmissionRange,
  growAdmittedRange,
  PREWARM_ADMISSION_BUDGET_ITEMS,
  rangeCovers,
} from './prewarmAdmission';
import {getCachedMean, measurementCacheKey, recordMeasurement} from './measurementCache';

/** Engaged-range change, as delivered by the native engine. Kept as a plain TS
 *  type for the public API — the Nitro callback itself is flattened to three
 *  scalars (performance-tips: "Avoid unnecessary objects"). */
export interface NitroListRangeChangeEvent {
  start: number;
  end: number;
  /** Bumped whenever offsets shift; forces re-positioning even when (start, end) held. */
  layoutVersion: number;
}

export type NitroListRenderTarget = 'Cell' | 'StickyHeader';

export type NitroListRenderItem<T> = (info: {
  item: T;
  index: number;
  target: NitroListRenderTarget;
}) => React.ReactElement | null;

export type NitroListScrollToOffsetParams = {
  offset: number;
  animated?: boolean;
};

export type NitroListScrollToIndexParams = {
  index: number;
  animated?: boolean;
  /** 0 = item top aligned to viewport top, 1 = item bottom to viewport bottom, 0.5 = centered. */
  viewPosition?: number;
  /** Extra dp added to the resulting scroll target after viewPosition is applied. */
  viewOffset?: number;
};

export type NitroListItemLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NitroListWindowSize = {
  width: number;
  height: number;
};

export type NitroListHandle = {
  scrollToOffset: (params: NitroListScrollToOffsetParams) => void;
  scrollToIndex: (params: NitroListScrollToIndexParams) => Promise<void>;
  scrollToEnd: (animated?: boolean) => void;
  /** Last scroll offset reported by the outer ScrollView, in dp. */
  getAbsoluteLastScrollOffset: () => number;
  /** Sync read of an item's top offset, in dp, from the native LayoutManager. */
  getItemOffset: (index: number) => number;
  getItemSize: (index: number) => number;
  /** Total scrollable size of the list, in dp. */
  getTotalSize: () => number;
  /** FlashList-compatible layout read. Returns undefined for out-of-range indices. */
  getLayout: (index: number) => NitroListItemLayout | undefined;
  /** Size of the visible area (the outer ScrollView), in dp. */
  getWindowSize: () => NitroListWindowSize;
  /** Distance between the ScrollView's content top and the first item — i.e. paddingTop. */
  getFirstItemOffset: () => number;
  /** Interop: the native node backing the outer ScrollView, as returned by
   *  its own `getScrollableNode()`. Reanimated resolves scrollables through
   *  exactly this (`useScrollOffset` & friends bind to it directly). */
  getScrollableNode: () => unknown;
  /** Interop: the host-component instance of the outer ScrollView (falls
   *  back to the scroll ref itself) — usable with `measure`,
   *  `dispatchCommand` and `scrollTo` interop from third-party code. */
  getNativeScrollRef: () => unknown;
};

export type NitroListRenderScrollComponentProps = {
  ref: React.Ref<ScrollView>;
  /** Plain JS handler — or, with `experimentalUiThreadScroll`, a Reanimated
   *  scroll handler that MUST land on an `Animated.ScrollView`. */
  onScroll:
    | ((e: NativeSyntheticEvent<NativeScrollEvent>) => void)
    | ScrollHandlerProcessed<Record<string, unknown>>;
  onScrollBeginDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (e: LayoutChangeEvent) => void;
  scrollEventThrottle: number;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Present when `initialScrollIndex`/`initialScrollOffset` was given: the
   *  estimated mount position, so iOS is born already scrolled (Android
   *  converges via a correction pass either way). Custom
   *  `renderScrollComponent` implementations should forward it. */
  contentOffset?: {x: number; y: number};
  children: React.ReactNode;
};

export type NitroListRenderScrollComponent = (
  props: NitroListRenderScrollComponentProps,
) => React.ReactElement;

export interface NitroListStickyHeaderConfig {
  /** Where the sticky bar sits, relative to the wrapper's top edge. dp. Default 0. */
  offset?: number;
  /** When true, hides the cell of the active sticky in the scrolled content
   *  (so the user only sees the floating overlay). Default false. */
  hideRelatedCell?: boolean;
}

export interface NitroListViewabilityConfig {
  /** Time (ms) an item must remain potentially viewable before it is reported. */
  minimumViewTime?: number;
  /** Percent of the viewport an item must cover. Mutually exclusive with itemVisiblePercentThreshold. */
  viewAreaCoveragePercentThreshold?: number;
  /** Percent of the item that must be visible. Mutually exclusive with viewAreaCoveragePercentThreshold. */
  itemVisiblePercentThreshold?: number;
  /** When true, no items are reported until the user has scrolled at least once. */
  waitForInteraction?: boolean;
}

export interface NitroListViewToken<T> {
  item: T;
  key: string;
  index: number | null;
  isViewable: boolean;
  timestamp: number;
}

export type NitroListOnViewableItemsChanged<T> = (info: {
  viewableItems: NitroListViewToken<T>[];
  changed: NitroListViewToken<T>[];
}) => void;

export interface NitroListProps<T> {
  data: ReadonlyArray<T> | null | undefined;
  renderItem: NitroListRenderItem<T>;
  /** Used until each item reports its actual size via onLayout. dp. */
  estimatedItemSize: number;
  keyExtractor?: (item: T, index: number) => string;
  /** Used as part of each item's React key segment, helping React not reuse a
   *  task cell as a header (or vice-versa) across data updates. */
  getItemType?: (item: T, index: number) => string | number;
  /** Escape hatch: change this value (compared with Object.is) to force a full
   *  measurement/layout reset even when keys are unchanged — e.g. when item
   *  heights depend on external state the keys don't capture (font scale,
   *  display density of content). Without it, a new `data` reference with the
   *  same keys is treated as a content-only update and keeps all caches. */
  dataVersion?: unknown;
  drawDistance?: number;
  style?: StyleProp<ViewStyle>;
  /** Render the consumer's outer ScrollView. Default = plain RN ScrollView. */
  renderScrollComponent?: NitroListRenderScrollComponent;
  /** Indices of items that should stick to the top as the user scrolls past them.
   *  MUST be sorted ascending. */
  stickyHeaderIndices?: number[];
  stickyHeaderConfig?: NitroListStickyHeaderConfig;
  onChangeStickyIndex?: (index: number) => void;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Reanimated handler run ON THE UI RUNTIME for every scroll event. MUST be
   *  a worklet — mark it with the 'worklet' directive (autoworkletization
   *  does not cross package boundaries). Only honored under
   *  `experimentalUiThreadScroll`; the fast alternative to a JS `onScroll`,
   *  which in that mode costs one JS wakeup per tick. */
  onScrollWorklet?: (event: ScrollEvent) => void;
  /** Shared value kept in sync with the absolute scroll offset (y, dp).
   *  Written on the UI runtime under `experimentalUiThreadScroll` (zero extra
   *  cost) and from the JS scroll handler otherwise. Drive parallax or
   *  collapsing headers from it without any additional wakeups. */
  scrollOffsetSharedValue?: SharedValue<number>;
  onScrollBeginDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Fires once after the first non-empty engaged range is rendered. */
  onLoad?: () => void;
  /** Called when the scroll gets within `onEndReachedThreshold` viewports of
   *  the end. Fires once per approach (latched); re-arms after scrolling away
   *  by 1.3× the threshold (hysteresis avoids flutter at the boundary), and
   *  re-fires without leaving when new content arrives while still near the
   *  end — which is what keeps infinite scroll loading page after page. */
  onEndReached?: (info: {distanceFromEnd: number}) => void;
  /** Distance from the end, in viewport-height units, at which `onEndReached`
   *  fires. Default 0.5 (half a screen). */
  onEndReachedThreshold?: number;
  /** Same contract as `onEndReached`, for the top edge (inverted feeds /
   *  loading older content). */
  onStartReached?: (info: {distanceFromStart: number}) => void;
  /** Default 0.5. */
  onStartReachedThreshold?: number;
  /** Keeps the first fully-visible item visually still when content above it
   *  changes size (images measuring in) or when the data changes around it
   *  (prepend/insert — requires `keyExtractor` to track the item's identity).
   *  The compensation happens against an anchor delta measured atomically in
   *  the native engine, plus a guard that swallows stale in-flight scroll
   *  events. Pinned at the very top (offset 0), new content pushes down
   *  naturally instead. Default false. */
  maintainVisibleContentPosition?: boolean;
  /** EXPERIMENTAL (F4 v2): drives the native engine's scroll offset from the
   *  UI thread via a Reanimated worklet — the engine stays fresh even when
   *  the JS thread is congested, and sticky headers are positioned entirely
   *  on the UI thread. In this mode the JS thread is NOT woken per scroll
   *  tick: ranges (with the offset they were computed at) arrive via
   *  `onRangeChange`; viewability gets throttled wakeups only when
   *  `onViewableItemsChanged` is set; a JS `onScroll` prop is honored but
   *  costs one wakeup per tick and receives a minimal synthesized event
   *  ({nativeEvent: {contentOffset}}) — prefer `onScrollWorklet`. The default
   *  scroll component becomes an `Animated.ScrollView`; a custom
   *  `renderScrollComponent` MUST be backed by one (plain ScrollViews ignore
   *  animated handlers). Default off. */
  experimentalUiThreadScroll?: boolean;
  /** Mount the list already positioned at this index — the first rendered
   *  window IS the destination (no flash of the top content), then a single
   *  measure-and-correct pass lands the exact offset. If the data arrives
   *  after mount, the target is preserved and applied when the index exists.
   *  Read once at mount; later changes are ignored (use scrollToIndex). */
  initialScrollIndex?: number;
  /** Mount at an absolute offset in dp (includes contentContainer padding).
   *  Takes precedence over `initialScrollIndex`. Read once at mount. */
  initialScrollOffset?: number;
  /** Chat-style bottom alignment: when the content is shorter than the
   *  viewport, a spacer above it pins everything to the bottom. Collapses to
   *  zero once the content outgrows the viewport. Default false. */
  alignItemsAtEnd?: boolean;
  /** Auto-stick to the end when new content arrives — but only if the user
   *  is already within `threshold` viewports of the end (default 0.1), so it
   *  never steals the scroll from someone reading history. Near the end this
   *  wins over `maintainVisibleContentPosition`. Default false. */
  maintainScrollAtEnd?: boolean | {threshold?: number; animated?: boolean};
  /** Rendered in flow above the items (below the alignItemsAtEnd spacer).
   *  Its measured height feeds the scroll math automatically. */
  ListHeaderComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  /** Rendered in flow below the items. */
  ListFooterComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  /** Rendered between header and footer when `data` is empty. */
  ListEmptyComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  /** Rendered inside every cell except the last one, below the item content —
   *  its height enters the cell measurement (and the offsets) automatically. */
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: T}> | null;
  /** Threshold config for which items count as "viewable". */
  viewabilityConfig?: NitroListViewabilityConfig;
  /** Called when the set of viewable indices changes. FlashList-compatible signature. */
  onViewableItemsChanged?: NitroListOnViewableItemsChanged<T>;
  /** Style applied to the inner ScrollView's content container. paddingTop /
   *  paddingBottom are honored for scroll-coordinate math (e.g. so that
   *  scrollToIndex lands the item below an absolute header). */
  contentContainerStyle?: StyleProp<ViewStyle>;
}

const defaultRenderScrollComponent: NitroListRenderScrollComponent = ({
  ref,
  onScroll,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollBegin,
  onMomentumScrollEnd,
  onLayout,
  scrollEventThrottle,
  contentContainerStyle,
  contentOffset,
  children,
}) => (
  <ScrollView
    ref={ref}
    style={StyleSheet.absoluteFill}
    contentContainerStyle={contentContainerStyle}
    contentOffset={contentOffset}
    onScroll={onScroll}
    onScrollBeginDrag={onScrollBeginDrag}
    onScrollEndDrag={onScrollEndDrag}
    onMomentumScrollBegin={onMomentumScrollBegin}
    onMomentumScrollEnd={onMomentumScrollEnd}
    onLayout={onLayout}
    scrollEventThrottle={scrollEventThrottle}>
    {children}
  </ScrollView>
);

// F4 default: the UI-thread driver needs an Animated.ScrollView — only
// createAnimatedComponent registers worklet handlers for the view's events;
// a plain ScrollView would silently ignore the animated onScroll object.
const defaultAnimatedRenderScrollComponent: NitroListRenderScrollComponent = ({
  ref,
  onScroll,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollBegin,
  onMomentumScrollEnd,
  onLayout,
  scrollEventThrottle,
  contentContainerStyle,
  contentOffset,
  children,
}) => (
  <Animated.ScrollView
    ref={ref as unknown as React.ComponentProps<typeof Animated.ScrollView>['ref']}
    style={StyleSheet.absoluteFill}
    contentContainerStyle={contentContainerStyle}
    contentOffset={contentOffset}
    onScroll={onScroll}
    onScrollBeginDrag={onScrollBeginDrag}
    onScrollEndDrag={onScrollEndDrag}
    onMomentumScrollBegin={onMomentumScrollBegin}
    onMomentumScrollEnd={onMomentumScrollEnd}
    onLayout={onLayout}
    scrollEventThrottle={scrollEventThrottle}>
    {children}
  </Animated.ScrollView>
);

const EMPTY: readonly never[] = Object.freeze([]);
const NO_STICKY: readonly number[] = Object.freeze([]);
// One prewarm jump straight to the target — the engine resolves the engaged
// range in O(log n), so interpolated stepping bought us nothing over a single
// setScrollOffset, only RAF waits. Correction passes still converge on the
// precise offset once cells around the target have laid out.
const SCROLL_TO_INDEX_STEPS = 1;
const SCROLL_TO_INDEX_BUFFER_MULTIPLIER = 2;
const SCROLL_TO_INDEX_MAX_RESTARTS = 3;
const SCROLL_TO_INDEX_TARGET_EPSILON = 1;
const SCROLL_TO_INDEX_CORRECTION_PASSES = 3;
// Minimum dp the scroll has to move before we re-evaluate viewability. Below
// this the visible set cannot change meaningfully — a 60% threshold on an
// 80dp item moves at 0.8dp per dp of scroll, so 3dp ≈ 2.4dp of threshold
// travel, which is finer than any human-perceivable boundary cross.
const VIEWABILITY_MIN_OFFSET_DELTA = 3;
// F4 v2: minimum interval between UI→JS viewability wakeups. Items can cross
// a visibility threshold without the engaged range moving (drawDistance
// slack), so `onViewableItemsChanged` consumers get a throttled tick — time
// AND travel gated, so a slow creep doesn't wake JS every 32ms for nothing.
const UI_VIEWABILITY_MIN_INTERVAL_MS = 32;
// maintainVisibleContentPosition tuning (LegendList-derived): corrections
// smaller than the epsilon are sub-visual jitter; the guard window covers the
// bridge latency of scroll events sampled before a correction landed.
const MVCP_POSITION_EPSILON = 0.1;
const MVCP_IGNORE_SCROLL_TTL_MS = 100;
// Fling-destination prewarm: below this launch speed the regular draw-ahead
// already covers the landing zone.
const FLING_MIN_VELOCITY_DP_S = 1500;
// Predicted travel per unit of launch velocity (dp per dp/s).
// iOS is exact: UIScrollView decays v(t) = v₀·0.998^t (t in ms), so total
// travel = v₀·(−1/ln 0.998)/1000 ≈ v₀ × 0.4995. Android's OverScroller uses a
// ppi/friction-dependent spline — 0.3 is a serviceable mid-range fit; the
// clamp below bounds the cost of any misprediction.
const FLING_TRAVEL_FACTOR = Platform.OS === 'ios' ? 0.4995 : 0.3;
const FLING_MAX_TRAVEL_VIEWPORTS = 4;
const FLING_PREWARM_MAX_ITEMS = 80;

type ItemTypeKey = string | number;

type RenderRange = {
  start: number;
  end: number;
};

function readNumericPadding(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractVerticalPadding(style: StyleProp<ViewStyle>): {top: number; bottom: number} {
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  if (!flat) return {top: 0, bottom: 0};
  const fallback = readNumericPadding(flat.padding);
  const vertical =
    flat.paddingVertical != null ? readNumericPadding(flat.paddingVertical) : fallback;
  return {
    top: flat.paddingTop != null ? readNumericPadding(flat.paddingTop) : vertical,
    bottom: flat.paddingBottom != null ? readNumericPadding(flat.paddingBottom) : vertical,
  };
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForLayoutPass(): Promise<void> {
  // One frame renders the new engaged range; the second lets item onLayout
  // feed measured sizes back into the native layout manager.
  await waitForNextFrame();
  await waitForNextFrame();
}

/** FlatList-compatible slot rendering: accepts a component type or an element. */
function renderSlot(
  Slot: React.ComponentType<unknown> | React.ReactElement | null | undefined,
): React.ReactElement | null {
  if (Slot == null) return null;
  return React.isValidElement(Slot) ? Slot : React.createElement(Slot);
}

function interpolateOffset(start: number, end: number, step: number, totalSteps: number): number {
  if (totalSteps <= 1) return end;
  const progress = step / (totalSteps - 1);
  return start + (end - start) * progress;
}

function pushRenderRange(
  ranges: RenderRange[],
  range: RenderRange | null | undefined,
  itemCount: number,
) {
  if (!range || range.end < range.start || itemCount <= 0) return;
  ranges.push({
    start: Math.max(0, range.start),
    end: Math.min(range.end, itemCount - 1),
  });
}

function mergeRenderRanges(ranges: RenderRange[]): RenderRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const merged: RenderRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({...range});
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

/**
 * True when at least one surviving index now holds a *different* item (by
 * key) than before — i.e. the index↔item mapping moved (insert/remove in the
 * middle, reorder, replace). False for pure re-wraps (selector returning a
 * new array of the same items), appends and tail trims: in those cases every
 * surviving index keeps its item, so measured sizes indexed by position are
 * still valid and nothing needs to reset.
 *
 * Items compared by reference first so the keyExtractor only runs for
 * indices whose element actually changed.
 */
function didKeysChangeStructurally<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyExtractor: (item: T, index: number) => string,
): boolean {
  const common = Math.min(prev.length, next.length);
  for (let i = 0; i < common; i++) {
    const p = prev[i];
    const n = next[i];
    if (p === n) continue;
    if (keyExtractor(p, i) !== keyExtractor(n, i)) return true;
  }
  return false;
}

// Once an edge fires, it only re-arms after the user scrolls away by 1.3× the
// threshold. Without the gap, momentum jitter right at the boundary would
// fire → re-arm → fire in quick succession.
const EDGE_HYSTERESIS_MULTIPLIER = 1.3;

type EdgeLatchState = {
  isReached: boolean;
  // Snapshot at fire time. While latched and still inside the threshold, the
  // edge re-fires only when one of these changed — i.e. a load finished and
  // appended content, so the consumer likely wants the next page.
  contentSize: number;
  dataLength: number;
};

function checkEdgeThreshold(
  state: EdgeLatchState,
  distance: number,
  thresholdDistance: number,
  contentSize: number,
  dataLength: number,
  fire: (distance: number) => void,
): void {
  if (!state.isReached) {
    if (distance <= thresholdDistance) {
      state.isReached = true;
      state.contentSize = contentSize;
      state.dataLength = dataLength;
      fire(distance);
    }
    return;
  }
  if (distance > thresholdDistance * EDGE_HYSTERESIS_MULTIPLIER) {
    state.isReached = false;
    return;
  }
  if (
    distance <= thresholdDistance &&
    (state.contentSize !== contentSize || state.dataLength !== dataLength)
  ) {
    state.contentSize = contentSize;
    state.dataLength = dataLength;
    fire(distance);
  }
}

type StickyComputeResult = {index: number; translateY: number; height: number};
type LayoutReader = (index: number) => number;

function computeSticky(
  scrollOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  readOffset: LayoutReader,
  readSize: LayoutReader,
): StickyComputeResult {
  'worklet';
  // Latest sticky whose natural y has reached/passed the sticky bar.
  // stickyIndices is sorted ascending and item offsets are monotonic in the
  // index, so binary-search the last one at/above the bar — O(log S) per
  // scroll tick instead of O(S).
  const bar = scrollOffset + stickyOffset;
  let activeK = -1;
  let lo = 0;
  let hi = stickyIndices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (readOffset(stickyIndices[mid]) <= bar) {
      activeK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (activeK === -1) {
    return {index: -1, translateY: stickyOffset, height: 0};
  }
  const idx = stickyIndices[activeK];
  const h = readSize(idx);
  let translateY = stickyOffset;
  const nextK = activeK + 1;
  if (nextK < stickyIndices.length) {
    const nextNaturalY = readOffset(stickyIndices[nextK]) - scrollOffset;
    if (nextNaturalY < stickyOffset + h) {
      translateY = nextNaturalY - h;
    }
  }
  return {index: idx, translateY, height: h};
}

/** W2: the sticky driver on the UI runtime. Reads layout straight from the
 *  hybrid (host functions — synchronous, lock-protected like any JS-thread
 *  call), writes the overlay translateY as a same-runtime shared-value write,
 *  and wakes the JS thread only when the ACTIVE INDEX changes (overlay
 *  content swap — a rare event). Shared by the per-tick scroll worklet and
 *  the one-shot recompute JS schedules after stationary layout changes. */
function driveStickyOnUi(
  hybrid: NitroListViewMethods,
  engineOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  translateYSv: SharedValue<number>,
  activeIndexSv: SharedValue<number>,
  notifyIndexChange: (index: number) => void,
): void {
  'worklet';
  const result = computeSticky(
    engineOffset,
    stickyIndices,
    stickyOffset,
    (i: number) => hybrid.getItemOffset(i),
    (i: number) => hybrid.getItemSize(i),
  );
  if (translateYSv.value !== result.translateY) {
    translateYSv.value = result.translateY;
  }
  if (activeIndexSv.value !== result.index) {
    activeIndexSv.value = result.index;
    scheduleOnRN(notifyIndexChange, result.index);
  }
}

/** Persistent per-handler state on the UI runtime (useAnimatedScrollHandler
 *  context) — the cheapest per-tick state channel there is: it lives on the
 *  UI runtime, zero serialization. */
type UiScrollContext = {
  lastY?: number;
  lastTime?: number;
  velocity?: number;
  lastViewabilityY?: number;
  lastViewabilityTime?: number;
};

function isItemViewable(
  itemTop: number,
  itemHeight: number,
  viewportTop: number,
  viewportHeight: number,
  config: NitroListViewabilityConfig,
): boolean {
  if (itemHeight <= 0 || viewportHeight <= 0) return false;
  const itemBottom = itemTop + itemHeight;
  const viewportBottom = viewportTop + viewportHeight;
  const visibleTop = Math.max(itemTop, viewportTop);
  const visibleBottom = Math.min(itemBottom, viewportBottom);
  const visibleHeight = visibleBottom - visibleTop;
  if (visibleHeight <= 0) return false;

  // Item is fully on screen — passes any threshold.
  if (itemTop >= viewportTop && itemBottom <= viewportBottom) {
    return true;
  }

  const {viewAreaCoveragePercentThreshold, itemVisiblePercentThreshold} = config;
  if (viewAreaCoveragePercentThreshold != null) {
    return (visibleHeight / viewportHeight) * 100 >= viewAreaCoveragePercentThreshold;
  }
  if (itemVisiblePercentThreshold != null) {
    return (visibleHeight / itemHeight) * 100 >= itemVisiblePercentThreshold;
  }
  // No threshold configured — any pixel visible counts.
  return true;
}

function NitroListInner<T>(props: NitroListProps<T>, ref: React.Ref<NitroListHandle>) {
  const {
    data,
    renderItem,
    estimatedItemSize,
    keyExtractor,
    getItemType,
    dataVersion,
    drawDistance = 250,
    style,
    renderScrollComponent,
    stickyHeaderIndices,
    stickyHeaderConfig,
    onChangeStickyIndex,
    onScroll: userOnScroll,
    onScrollWorklet,
    scrollOffsetSharedValue,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onLoad,
    onEndReached,
    onEndReachedThreshold,
    onStartReached,
    onStartReachedThreshold,
    maintainVisibleContentPosition,
    experimentalUiThreadScroll,
    initialScrollIndex,
    initialScrollOffset,
    alignItemsAtEnd = false,
    maintainScrollAtEnd,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ItemSeparatorComponent,
    viewabilityConfig,
    onViewableItemsChanged,
    contentContainerStyle,
  } = props;

  // W4: under the UI-thread driver the default outer ScrollView must be an
  // Animated one, or the worklet handler would be silently ignored.
  const resolvedRenderScrollComponent =
    renderScrollComponent ??
    (experimentalUiThreadScroll === true
      ? defaultAnimatedRenderScrollComponent
      : defaultRenderScrollComponent);

  const items = (data ?? EMPTY) as ReadonlyArray<T>;
  const itemCount = items.length;
  const stickyIndices = stickyHeaderIndices ?? NO_STICKY;
  const stickyOffset = stickyHeaderConfig?.offset ?? 0;
  const hideRelatedCell = stickyHeaderConfig?.hideRelatedCell ?? false;

  // Vertical padding from contentContainerStyle is applied to the inner
  // ScrollView's content. NitroListView's local item coords have origin 0, so
  // when reporting scroll to the engine we subtract paddingTop. Tracked in a
  // ref so callbacks don't depend on the parsed numbers directly.
  const {top: paddingTop, bottom: paddingBottom} = useMemo(
    () => extractVerticalPadding(contentContainerStyle),
    [contentContainerStyle],
  );

  // Measured sizes of the in-flow companions above/below the items, plus the
  // alignItemsAtEnd spacer. They sit in normal layout flow around the
  // NitroListView host, so cells never know about them — only the coordinate
  // math does, through `effectivePaddingTop`.
  const [headerSize, setHeaderSize] = useState(0);
  const [footerSize, setFooterSize] = useState(0);
  const [alignPad, setAlignPad] = useState(0);

  // THE single conversion between absolute scroll coordinates and engine
  // (item-local) coordinates. Every consumer — scroll reporting, scrollTo
  // math, viewability, sticky, edges — reads this ref.
  const effectivePaddingTop = paddingTop + headerSize + alignPad;
  const effectivePaddingTopRef = useRef(effectivePaddingTop);
  // Keep the ref aligned without a separate effect — refs can be safely
  // assigned during render.
  effectivePaddingTopRef.current = effectivePaddingTop;

  // Initial mount position, captured once from the first render's props.
  // `offset` is the best pre-attach estimate: it seeds lastScrollOffsetRef
  // (so the very first engaged range native computes is already the
  // destination window — no flash of the top content) and the ScrollView's
  // mount contentOffset (iOS is born scrolled). `index` targets get an exact
  // measure-and-correct pass once data + viewport exist; `settled` latches.
  const initialTargetRef = useRef<{offset: number; index: number | null; settled: boolean} | null>(
    null,
  );
  if (initialTargetRef.current === null) {
    if (initialScrollOffset != null && initialScrollOffset > 0) {
      initialTargetRef.current = {offset: initialScrollOffset, index: null, settled: false};
    } else if (initialScrollIndex != null && initialScrollIndex > 0) {
      initialTargetRef.current = {
        offset: paddingTop + initialScrollIndex * estimatedItemSize,
        index: initialScrollIndex,
        settled: false,
      };
    } else {
      initialTargetRef.current = {offset: 0, index: null, settled: true};
    }
  }

  // Stable identity: the ScrollView's mount offset never changes after the
  // first render (later positioning goes through the imperative path).
  const initialContentOffset = useMemo<{x: number; y: number} | undefined>(() => {
    const initial = initialTargetRef.current;
    return initial != null && initial.offset > 0 ? {x: 0, y: initial.offset} : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollRef = useRef<ScrollView>(null);
  const hybridRef = useRef<NitroListViewMethods | null>(null);

  // Sticky overlay translateY — hoisted so both drivers write the same value:
  // the JS path (default mode) and the UI-runtime worklet (F4 + sticky, W2).
  const stickyTranslateYSv = useSharedValue(stickyOffset);
  // Active sticky index as seen by the UI runtime — dedupes UI→JS wakeups.
  const uiStickyIndexSv = useSharedValue(-1);
  // W0: last translateY written by the JS path. Reading translateY.value to
  // dedupe would BLOCK the JS thread until the UI thread answers
  // (useSharedValue docs) — on the hottest path we have. null = baseline
  // unknown (the UI driver may have written since); next JS write goes
  // through unconditionally.
  const lastJsStickyTyRef = useRef<number | null>(null);

  // Cached mirror of the native LayoutManager. Reads of offset/size/totalSize
  // are hot during scroll (viewability evaluation, sticky resolution, render
  // loop) and each JSI roundtrip pays a non-trivial cost (Swift unfair lock +
  // ensureClean + Double conversion). Per-index entries are tagged with a
  // generation; bumping `gen` invalidates everything in O(1).
  const layoutCacheRef = useRef({
    gen: 1,
    capacity: 0,
    tops: new Float64Array(0),
    sizes: new Float64Array(0),
    topsGen: new Int32Array(0),
    sizesGen: new Int32Array(0),
    totalSize: 0,
    totalSizeGen: 0,
  });

  const invalidateLayoutCache = useCallback(() => {
    layoutCacheRef.current.gen++;
  }, []);

  // ---- maintainVisibleContentPosition state --------------------------------
  // `anchor` = first fully-visible item, captured on real scroll events — by
  // construction its offset reflects the pre-mutation layout. `enabled`
  // mirrors the prop (render-time assignment, same pattern as paddingTopRef).
  // The guard swallows scroll events sampled before a programmatic correction
  // landed (they'd report the stale side and undo the correction).
  const mvcpStateRef = useRef<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>({enabled: false, anchor: null});
  mvcpStateRef.current.enabled = maintainVisibleContentPosition === true;
  if (!mvcpStateRef.current.enabled) {
    mvcpStateRef.current.anchor = null;
  }
  const mvcpGuardRef = useRef<{
    threshold: number;
    staleBelow: boolean;
    expiresAt: number;
  } | null>(null);
  // Populated after scrollToAbsoluteOffset exists (declared much later); the
  // flush pipeline below reaches corrections through this ref.
  const applyMvcpCorrectionRef = useRef<(diff: number) => void>(() => {});
  // Mirrors the latest engaged range for cheap anchor lookup on scroll.
  const latestRangeRef = useRef<{start: number; end: number}>({start: 0, end: -1});
  const isPrewarmingRangeRef = useRef(false);
  // Scroll-gesture lifecycle. A scrollTo during drag/momentum kills the
  // platform fling, so MVCP corrections accumulate in `pendingAdjust` while
  // a gesture is active and apply as one adjustment at settle.
  const scrollActivityRef = useRef<{
    dragging: boolean;
    momentum: boolean;
    pendingAdjust: number;
  }>({dragging: false, momentum: false, pendingAdjust: 0});
  // Rolling launch-velocity estimate from real scroll events (dp/s). Own
  // estimator instead of the event's `velocity` field — its sign convention
  // differs across platforms/RN versions.
  const scrollVelocityRef = useRef<{offset: number; time: number; velocity: number}>({
    offset: 0,
    time: 0,
    velocity: 0,
  });
  // Fling-destination prewarm entry point; populated after the layout
  // readers/clamp helpers exist (declared much later).
  const prewarmFlingDestinationRef = useRef<() => void>(() => {});
  // Budgeted admission of the fling prewarm (R1, prewarmAdmission.ts): the
  // predicted window mounts in per-frame slices instead of one burst. Only
  // the P3 speculative path runs through this — live range and scrollToIndex
  // prewarm mount unbudgeted.
  const flingAdmissionRef = useRef<{
    target: AdmissionRange;
    focus: AdmissionRange;
    admitted: AdmissionRange | null;
    direction: 1 | -1;
    rafId: number | null;
  } | null>(null);
  const cancelFlingPrewarm = useCallback(() => {
    const admission = flingAdmissionRef.current;
    if (admission != null) {
      if (admission.rafId != null) cancelAnimationFrame(admission.rafId);
      flingAdmissionRef.current = null;
    }
  }, []);
  useEffect(() => cancelFlingPrewarm, [cancelFlingPrewarm]);

  // Staging buffer for batching per-cell onLayout reports into a single
  // `setItemSizesBatch` JSI call per frame. The native side (iOS Swift /
  // Android Kotlin) coalesces this into one lock + one `maybeEmitRange`
  // instead of N×JSI, N×layoutVersion bumps and (on Android) N×requestLayout.
  // Layout (Float64): [idx0, size0, idx1, size1, ...]; sizes in dp.
  //
  // Scheduling note: each native onLayout event arrives as its own JS task,
  // and microtasks drain between tasks. So `queueMicrotask` would flush per
  // event and defeat batching. A frame-scoped scheduler (requestAnimationFrame)
  // coalesces every cell's onLayout fired during the current frame into one
  // flush before the next paint.
  const pendingSizesRef = useRef<{
    buffer: Float64Array;
    count: number;
    rafId: number | null;
  }>({buffer: new Float64Array(32 * 2), count: 0, rafId: null});

  // Latest items/getItemType for the measurement-cache feeder (R3). Through a
  // ref so flushPendingItemSizes (→ enqueueItemSize → every cell's props)
  // keeps a stable identity across data changes.
  const measurementCtxRef = useRef<{
    items: ReadonlyArray<T>;
    getItemType?: (item: T, index: number) => ItemTypeKey;
  }>({items, getItemType});
  useEffect(() => {
    measurementCtxRef.current = {items, getItemType};
  });

  const flushPendingItemSizes = useCallback(
    (emitRange: boolean = true) => {
      const state = pendingSizesRef.current;
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      const pairCount = state.count;
      if (pairCount === 0) return;
      const hybrid = hybridRef.current;
      if (!hybrid) {
        // No native host attached yet — re-arm so the buffered sizes get
        // flushed once the host attaches (handled by handleHybridRef).
        return;
      }
      // Native reads `pairs.size` and walks pair-by-pair, so we must hand it a
      // tight buffer of exactly `pairCount * 2` doubles. A fresh allocation
      // here is cheaper than carrying a growing buffer back and forth.
      const tight = new Float64Array(pairCount * 2);
      tight.set(state.buffer.subarray(0, pairCount * 2));
      state.count = 0;
      if (NITRO_LIST_PERF_COMPILED) {
        NitroListPerfMonitor.recordBatchFlush(pairCount);
        NitroListPerfMonitor.recordJsiCall();
      }
      const mvcp = mvcpStateRef.current;
      const anchor = mvcp.enabled && !isPrewarmingRangeRef.current ? mvcp.anchor : null;
      if (anchor != null) {
        // MVCP size trigger: apply the batch and measure the anchor's shift
        // under one native lock, then compensate the scroll so the content
        // under the user's eyes stays still while items above it re-measure.
        const diff = hybrid.setItemSizesBatchAnchored(tight.buffer, anchor.index, emitRange);
        invalidateLayoutCache();
        if (Math.abs(diff) > MVCP_POSITION_EPSILON) {
          applyMvcpCorrectionRef.current(diff);
        }
      } else {
        hybrid.setItemSizesBatch(tight.buffer, emitRange);
        // Native now holds fresh sizes — cached offsets/sizes are stale.
        // onRangeChange will also invalidate eventually, but it's async; do it
        // eagerly so the next synchronous read sees fresh values.
        invalidateLayoutCache();
      }
      // R3: feed the cross-mount measurement cache — one running mean per
      // (type, width bucket, font scale). Typed lists only: type 0 (untyped)
      // can't be seeded natively, so caching it would never pay off.
      const ctx = measurementCtxRef.current;
      const widthDp = viewportSizeRef.current.width;
      if (ctx.getItemType != null && widthDp > 0) {
        const fontScale = PixelRatio.getFontScale();
        for (let k = 0; k < pairCount; k++) {
          const idx = tight[k * 2] | 0;
          const item = ctx.items[idx];
          if (item === undefined) continue;
          recordMeasurement(
            measurementCacheKey(ctx.getItemType(item, idx), widthDp, fontScale),
            tight[k * 2 + 1],
          );
        }
      }
    },
    [invalidateLayoutCache],
  );

  const enqueueItemSize = useCallback(
    (index: number, sizeDp: number) => {
      const state = pendingSizesRef.current;
      const neededSlots = (state.count + 1) * 2;
      if (neededSlots > state.buffer.length) {
        const next = new Float64Array(state.buffer.length * 2);
        next.set(state.buffer);
        state.buffer = next;
      }
      const offset = state.count * 2;
      state.buffer[offset] = index;
      state.buffer[offset + 1] = sizeDp;
      state.count++;
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(() => {
          // flushPendingItemSizes resets rafId; capture-by-closure is fine.
          flushPendingItemSizes();
        });
      }
    },
    [flushPendingItemSizes],
  );

  // Cancel any pending RAF on unmount so we don't flush into a torn-down host.
  useEffect(
    () => () => {
      const state = pendingSizesRef.current;
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      state.count = 0;
    },
    [],
  );

  const ensureCacheCapacity = useCallback((count: number) => {
    const c = layoutCacheRef.current;
    if (count <= c.capacity) return;
    const next = Math.max(count, c.capacity > 0 ? c.capacity * 2 : 16);
    const tops = new Float64Array(next);
    const sizes = new Float64Array(next);
    const topsGen = new Int32Array(next);
    const sizesGen = new Int32Array(next);
    if (c.capacity > 0) {
      tops.set(c.tops);
      sizes.set(c.sizes);
      topsGen.set(c.topsGen);
      sizesGen.set(c.sizesGen);
    }
    c.tops = tops;
    c.sizes = sizes;
    c.topsGen = topsGen;
    c.sizesGen = sizesGen;
    c.capacity = next;
  }, []);

  const readItemOffset = useCallback(
    (index: number): number => {
      if (index < 0) return 0;
      const hybrid = hybridRef.current;
      if (hybrid == null) return index * estimatedItemSize;
      const c = layoutCacheRef.current;
      if (index < c.capacity && c.topsGen[index] === c.gen) {
        return c.tops[index];
      }
      const v = hybrid.getItemOffset(index);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      ensureCacheCapacity(index + 1);
      const c2 = layoutCacheRef.current;
      c2.tops[index] = v;
      c2.topsGen[index] = c2.gen;
      return v;
    },
    [ensureCacheCapacity, estimatedItemSize],
  );

  const readItemSize = useCallback(
    (index: number): number => {
      if (index < 0) return 0;
      const hybrid = hybridRef.current;
      if (hybrid == null) return estimatedItemSize;
      const c = layoutCacheRef.current;
      if (index < c.capacity && c.sizesGen[index] === c.gen) {
        return c.sizes[index];
      }
      const v = hybrid.getItemSize(index);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      ensureCacheCapacity(index + 1);
      const c2 = layoutCacheRef.current;
      c2.sizes[index] = v;
      c2.sizesGen[index] = c2.gen;
      return v;
    },
    [ensureCacheCapacity, estimatedItemSize],
  );

  const readTotalSize = useCallback((): number => {
    const hybrid = hybridRef.current;
    if (hybrid == null) return Math.max(0, itemCount * estimatedItemSize);
    const c = layoutCacheRef.current;
    if (c.totalSizeGen === c.gen) return c.totalSize;
    const v = hybrid.getTotalSize();
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    c.totalSize = v;
    c.totalSizeGen = c.gen;
    return v;
  }, [estimatedItemSize, itemCount]);

  // Keep the latest scroll offset and viewport size in refs — JS does not need
  // to re-render on each scroll, only when the engaged range or active sticky
  // changes. Seeded with the initial-scroll target so the first native range
  // computation (host attach replays this value) is already the destination.
  const lastScrollOffsetRef = useRef(initialTargetRef.current?.offset ?? 0);
  const viewportSizeRef = useRef<{width: number; height: number}>({width: 0, height: 0});
  const hasFiredOnLoadRef = useRef(false);
  // Dev-only: mount-time anchor for the first-range (TTFI proxy) measurement;
  // the PerfMonitor re-anchors it to its last reset() when that is later.
  const mountTimestampRef = useRef(Date.now());
  const stickyIndexRef = useRef(-1);

  // Edge-callback latches (onEndReached / onStartReached).
  const endEdgeStateRef = useRef<EdgeLatchState>({
    isReached: false,
    contentSize: 0,
    dataLength: 0,
  });
  const startEdgeStateRef = useRef<EdgeLatchState>({
    isReached: false,
    contentSize: 0,
    dataLength: 0,
  });

  // maintainScrollAtEnd, normalized (render-assigned like the other prop
  // mirrors so the edge checker never re-binds on prop identity).
  const maintainAtEndRef = useRef<{threshold: number; animated: boolean} | null>(null);
  maintainAtEndRef.current = maintainScrollAtEnd
    ? {
        threshold:
          typeof maintainScrollAtEnd === 'object' && maintainScrollAtEnd.threshold != null
            ? maintainScrollAtEnd.threshold
            : 0.1,
        animated: typeof maintainScrollAtEnd === 'object' && maintainScrollAtEnd.animated === true,
      }
    : null;
  const stickToEndRef = useRef<{wasAtEnd: boolean; lastContent: number; pending: boolean}>({
    wasAtEnd: false,
    lastContent: 0,
    pending: false,
  });
  // Populated once getMaxScrollOffset/scrollToAbsoluteOffset exist (later).
  const scrollToEndForMaintainRef = useRef<(animated: boolean) => void>(() => {});
  // Populated once readTotalSize/range exist (later).
  const updateAlignPadRef = useRef<() => void>(() => {});

  const checkEdgeCallbacks = useCallback(() => {
    const maintain = maintainAtEndRef.current;
    if (!onEndReached && !onStartReached && maintain == null) return;
    const viewportH = viewportSizeRef.current.height;
    if (viewportH <= 0 || itemCount === 0) return;
    const totalContent =
      effectivePaddingTopRef.current + readTotalSize() + footerSize + paddingBottom;
    const scrollY = lastScrollOffsetRef.current;
    // maintainScrollAtEnd: `wasAtEnd` tracks the pre-growth position (the
    // distance right after growth is momentarily huge — that's the very
    // signal to stick, not to bail). The RAF re-checks before scrolling so a
    // user who grabbed the list meanwhile keeps it.
    if (maintain != null) {
      const stick = stickToEndRef.current;
      const contentGrew = totalContent > stick.lastContent + 1;
      if (!contentGrew) {
        stick.wasAtEnd =
          totalContent - scrollY - viewportH <= maintain.threshold * viewportH ||
          totalContent <= viewportH;
      } else if (stick.wasAtEnd && !stick.pending) {
        const activity = scrollActivityRef.current;
        if (!activity.dragging && !activity.momentum) {
          const animated = maintain.animated;
          stick.pending = true;
          requestAnimationFrame(() => {
            stick.pending = false;
            const act = scrollActivityRef.current;
            if (!stickToEndRef.current.wasAtEnd || act.dragging || act.momentum) return;
            scrollToEndForMaintainRef.current(animated);
          });
        }
      }
      stick.lastContent = totalContent;
    }
    if (onEndReached) {
      checkEdgeThreshold(
        endEdgeStateRef.current,
        totalContent - scrollY - viewportH,
        (onEndReachedThreshold ?? 0.5) * viewportH,
        totalContent,
        itemCount,
        (distanceFromEnd) => onEndReached({distanceFromEnd}),
      );
    } else {
      endEdgeStateRef.current.isReached = false;
    }
    if (onStartReached) {
      checkEdgeThreshold(
        startEdgeStateRef.current,
        scrollY,
        (onStartReachedThreshold ?? 0.5) * viewportH,
        totalContent,
        itemCount,
        (distanceFromStart) => onStartReached({distanceFromStart}),
      );
    } else {
      startEdgeStateRef.current.isReached = false;
    }
  }, [
    onEndReached,
    onStartReached,
    onEndReachedThreshold,
    onStartReachedThreshold,
    itemCount,
    footerSize,
    paddingBottom,
    readTotalSize,
  ]);

  // Scroll/layout/range handlers reach the checker through a ref so they don't
  // re-bind whenever a threshold or callback identity changes.
  const checkEdgeCallbacksRef = useRef(checkEdgeCallbacks);
  useEffect(() => {
    checkEdgeCallbacksRef.current = checkEdgeCallbacks;
    // Content/data changes can cross an edge with the scroll standing still —
    // e.g. a page appended while the user waits at the end, or the list
    // shrinking under them. Evaluate on every dep change, not just on scroll.
    checkEdgeCallbacks();
  }, [checkEdgeCallbacks]);

  // Viewability state. `viewableMap` holds indices currently confirmed viewable;
  // `pendingMap` tracks indices in their `minimumViewTime` debounce window.
  const viewableMapRef = useRef<Map<number, NitroListViewToken<T>>>(new Map());
  const pendingMapRef = useRef<Map<number, number>>(new Map());
  const viewabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasInteractedRef = useRef(false);
  const evaluateViewabilityRef = useRef<() => void>(() => {});
  // Last (offset, range, layoutVersion) the viewability evaluator actually
  // examined. While the user is mid-scroll we skip sub-`MIN_OFFSET_DELTA`
  // increments — the visible set is mathematically unable to change — to keep
  // the scroll handler off the hot path.
  const lastViewabilityEvalRef = useRef<{
    offset: number;
    start: number;
    end: number;
    layoutVersion: number;
  }>({offset: Number.NaN, start: -1, end: -2, layoutVersion: -1});
  // Interned getItemType results → uint16 ids for the native per-type size
  // averages (0 is reserved for "untyped"). `lastSentTypesRef` dedupes sends:
  // a content-only data change produces the identical array and skips the
  // JSI call + native re-resolve entirely.
  const typeIdMapRef = useRef<Map<ItemTypeKey, number>>(new Map());
  const lastSentTypesRef = useRef<Uint16Array | null>(null);

  // R3: pushes cross-mount cached means into the core's type stats. Cheap and
  // idempotent — the core ignores types that already have real samples, so
  // this can run on every type push and on viewport-width changes (the cache
  // key includes the width bucket, so a rotation reads a different bucket).
  const seedTypeMeansFromCache = useCallback(() => {
    const hybrid = hybridRef.current;
    if (!hybrid) return;
    const map = typeIdMapRef.current;
    const widthDp = viewportSizeRef.current.width;
    if (map.size === 0 || widthDp <= 0) return;
    const fontScale = PixelRatio.getFontScale();
    let seedCount = 0;
    const seeds = new Float64Array(map.size * 2);
    for (const [type, id] of map) {
      const mean = getCachedMean(measurementCacheKey(type, widthDp, fontScale));
      if (mean != null) {
        seeds[seedCount * 2] = id;
        seeds[seedCount * 2 + 1] = mean;
        seedCount++;
      }
    }
    if (seedCount === 0) return;
    // Tight copy: native derives the pair count from the buffer's byte length.
    hybrid.seedTypeMeans(seeds.slice(0, seedCount * 2).buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
  }, []);
  // Reusable Float64 slab for one-call layout-cache hydration. Layout:
  // [layoutVersion, totalSize, start, end, offset(start), size(start), …].
  const slabRef = useRef<Float64Array<ArrayBuffer>>(new Float64Array(4 + 2 * 64));
  // Scratch collections for `evaluateViewability` — re-used across calls to
  // avoid allocating a Set + 2 arrays on every scroll tick. `removed` and
  // `newlyViewable` are spread into the `changed` array passed to the
  // consumer, so callers see a fresh array and can hold it safely.
  const viewabilityScratchRef = useRef<{
    potential: Set<number>;
    pendingKeysSnapshot: number[];
    removed: NitroListViewToken<T>[];
    newlyViewable: NitroListViewToken<T>[];
  }>({
    potential: new Set(),
    pendingKeysSnapshot: [],
    removed: [],
    newlyViewable: [],
  });
  const scrollCommandIdRef = useRef(0);
  // Mirrors the latest engaged range observed during prewarm. Used to promote
  // it into `range` when prewarm finishes — the native engine may dedupe a
  // repeated setScrollOffset call (same value as the last prewarm step) and
  // skip emitting onRangeChange, leaving `range` stuck at the pre-scroll
  // window and rendering blank inside the visible viewport.
  const lastPrewarmRangeRef = useRef<{
    start: number;
    end: number;
    layoutVersion: number;
  } | null>(null);

  // Interns getItemType results and ships one uint16 id per index to the
  // native per-type size averages. Sends are deduped against the last array —
  // a selector re-wrap with identical types costs one O(N) compare, no JSI.
  const pushItemTypes = useCallback(() => {
    const hybrid = hybridRef.current;
    if (!hybrid || itemCount === 0) return;
    const arr = new Uint16Array(itemCount);
    if (getItemType) {
      const map = typeIdMapRef.current;
      for (let i = 0; i < itemCount; i++) {
        const type = getItemType(items[i], i);
        let id = map.get(type);
        if (id == null) {
          id = Math.min(map.size + 1, 65535);
          map.set(type, id);
        }
        arr[i] = id;
      }
    }
    // Without getItemType the array stays all-zeros: a single shared bucket,
    // i.e. the native mean degenerates to a global average item size.
    const last = lastSentTypesRef.current;
    if (last != null && last.length === arr.length) {
      let equal = true;
      for (let i = 0; i < arr.length; i++) {
        if (last[i] !== arr[i]) {
          equal = false;
          break;
        }
      }
      if (equal) return;
    }
    lastSentTypesRef.current = arr;
    hybrid.setItemTypes(arr.buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    // R3: re-seed after every real type push — new types may have appeared.
    seedTypeMeansFromCache();
  }, [getItemType, itemCount, items, seedTypeMeansFromCache]);

  // Scroll/attach handlers reach the pusher through a ref so their identity
  // (and the host ref callback's) doesn't churn on every data change.
  const pushItemTypesRef = useRef(pushItemTypes);
  useEffect(() => {
    pushItemTypesRef.current = pushItemTypes;
    // Ordering vs. the data-change effect is irrelevant: both setItemTypes
    // and resetItemSizes re-resolve every unmeasured size against the type
    // means, so either sequence converges to the same layout.
    pushItemTypes();
  }, [pushItemTypes]);

  const handleHybridRef = useCallback(
    (value: NitroListViewMethods | null) => {
      hybridRef.current = value;
      // Mirror into state so the F4 worklet handler can capture the hybrid
      // object by closure (refs don't serialize into worklets; the object
      // itself does, via Nitro's react-native-worklets integration).
      setAttachedHybrid(value);
      // Either swapping the host or attaching for the first time can shift the
      // native layout state under our feet.
      invalidateLayoutCache();
      if (!value) return;
      // The outer ScrollView's onLayout/onScroll may have fired before the
      // HybridView was attached; replay the current state so native isn't stuck
      // with viewport=0 (which would make the engaged range empty).
      const {width, height} = viewportSizeRef.current;
      if (width > 0 || height > 0) {
        value.setViewport(width, height);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
      const replayEngineOffset = lastScrollOffsetRef.current - effectivePaddingTopRef.current;
      value.setScrollOffset(replayEngineOffset);
      lastPushedEngineOffsetRef.current = replayEngineOffset;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      // A fresh host has no type table — force a resend.
      lastSentTypesRef.current = null;
      pushItemTypesRef.current();
      // Drain any onLayout reports that arrived before the host attached.
      flushPendingItemSizes();
      evaluateViewabilityRef.current();
    },
    [invalidateLayoutCache, flushPendingItemSizes],
  );
  const hybridRefCb = useMemo(() => callback(handleHybridRef), [handleHybridRef]);

  // F4: the hybrid object as state (not ref) — worklet closures capture it at
  // handler creation; Nitro packs/unpacks it across runtimes automatically.
  const [attachedHybrid, setAttachedHybrid] = useState<NitroListViewMethods | null>(null);
  const uiThreadDriverActive =
    experimentalUiThreadScroll === true && attachedHybrid != null;
  const uiThreadDriverActiveRef = useRef(uiThreadDriverActive);
  uiThreadDriverActiveRef.current = uiThreadDriverActive;

  // ---- F4 shared state on the UI runtime ------------------------------------
  // Mirrors written by JS (JS→UI shared-value writes are async and cheap;
  // only READS from the JS side block — the W0 lesson).
  const uiPaddingTopSv = useSharedValue(0);
  useEffect(() => {
    uiPaddingTopSv.value = effectivePaddingTop;
  }, [effectivePaddingTop, uiPaddingTopSv]);
  // Last engine offset the worklet pushed — read by one-shot UI recomputes
  // (sticky after stationary layout changes) on their own runtime, so no
  // offset ever needs to be read back on the JS thread. Seeded/refreshed by
  // JS on mount and on programmatic scrolls (writes, never reads).
  const uiScrollOffsetSv = useSharedValue(
    (initialTargetRef.current?.offset ?? 0) - paddingTop,
  );
  useEffect(() => {
    // Driver mode flip: the other runtime may have written translateY since —
    // the JS dedupe baseline is unknowable without a blocking read, so drop
    // it and let the next JS write land unconditionally.
    lastJsStickyTyRef.current = null;
  }, [uiThreadDriverActive]);

  const [range, setRange] = useState<{
    start: number;
    end: number;
    layoutVersion: number;
  }>({start: 0, end: -1, layoutVersion: 0});
  const [prewarmRange, setPrewarmRange] = useState<{
    start: number;
    end: number;
    layoutVersion: number;
  } | null>(null);

  // Active sticky index lives in component state so the engaged-cells loop can
  // hide the matching cell when `hideRelatedCell` is on. It only updates when
  // the *index* changes — the smooth translateY transitions ride the shared
  // value the overlay consumes, avoiding a parent re-render every scroll
  // frame.
  const [stickyIndexState, setStickyIndexState] = useState(-1);

  // Hydrates the JS layout cache for the engaged range in a single JSI call
  // (atomic snapshot under the native lock) instead of up to 2×range
  // getItemOffset/getItemSize round-trips as the render loop misses.
  // Writes an already-filled slab ([version, total, start, end, (offset,
  // size)…]) into the layout cache. Shared by hydrateFromSlab (pull after an
  // async range event) and applyScrollOffsetSync (the F3 same-tick path).
  const writeSlabToCache = useCallback(
    (slab: Float64Array, written: number) => {
      const c = layoutCacheRef.current;
      const start = slab[2] | 0;
      ensureCacheCapacity(start + written);
      const gen = c.gen;
      for (let k = 0; k < written; k++) {
        const i = start + k;
        const base = 4 + 2 * k;
        c.tops[i] = slab[base];
        c.topsGen[i] = gen;
        c.sizes[i] = slab[base + 1];
        c.sizesGen[i] = gen;
      }
      c.totalSize = slab[1];
      c.totalSizeGen = gen;
    },
    [ensureCacheCapacity],
  );

  const hydrateFromSlab = useCallback(
    (expectedStart: number, expectedEnd: number) => {
      const hybrid = hybridRef.current;
      if (!hybrid) return;
      const required = 4 + 2 * Math.max(0, expectedEnd - expectedStart + 1) + 16;
      if (slabRef.current.length < required) {
        slabRef.current = new Float64Array(required);
      }
      let slab = slabRef.current;
      let written = hybrid.fillLayoutSlab(slab.buffer);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) {
        // The live range outgrew the event's snapshot — grow once and retry.
        slabRef.current = new Float64Array(slab.length * 2);
        slab = slabRef.current;
        written = hybrid.fillLayoutSlab(slab.buffer);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        if (written < 0) return; // per-item reads still work as the fallback
      }
      writeSlabToCache(slab, written);
    },
    [writeSlabToCache],
  );

  const lastSeenLayoutVersionRef = useRef<number>(-1);
  // MVCP anchor capture, routed through a ref: the capture depends on
  // items/keyExtractor, and handleRangeChange must keep a stable identity —
  // a rebuilt callback makes native reset its dedupe and re-emit.
  const captureMvcpAnchorRef = useRef<(engineOffset: number) => void>(() => {});
  const handleRangeChange = useCallback(
    (start: number, end: number, layoutVersion: number, engineOffset: number) => {
      const event: NitroListRangeChangeEvent = {start, end, layoutVersion};
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        NitroListPerfMonitor.recordRangeEvent();
        if (event.end >= event.start) {
          NitroListPerfMonitor.recordFirstRange(mountTimestampRef.current);
        }
      }
      // F4 v2: the UI-thread worklet is the only offset driver and the JS
      // thread is never woken per tick — this emission (which native already
      // dedupes to real changes) is ALSO the scroll-bookkeeping channel. The
      // offset it was computed at rides along, so JS re-syncs without ever
      // reading a shared value (a blocking JS-thread read).
      const uiDriven = uiThreadDriverActiveRef.current && !isPrewarmingRangeRef.current;
      let offsetConsumed = false;
      if (uiDriven) {
        const absoluteY = engineOffset + effectivePaddingTopRef.current;
        // Same stale-event guard as handleOuterScroll: an emission computed
        // before a programmatic MVCP correction can arrive after it and
        // would roll the bookkeeping back to the pre-correction side. The
        // range itself is always kept — React must still mount it.
        const guard = mvcpGuardRef.current;
        let stale = false;
        if (guard != null) {
          if (Date.now() > guard.expiresAt) {
            mvcpGuardRef.current = null;
          } else if (guard.staleBelow ? absoluteY < guard.threshold : absoluteY > guard.threshold) {
            stale = true;
          } else {
            mvcpGuardRef.current = null;
          }
        }
        if (!stale) {
          lastScrollOffsetRef.current = absoluteY;
          offsetConsumed = true;
        }
      }
      // Native only bumps layoutVersion when offsets actually shifted. A
      // pure scroll changes (start, end) without bumping the version, so
      // the cached offsets/sizes remain accurate and we skip invalidation.
      if (event.layoutVersion !== lastSeenLayoutVersionRef.current) {
        lastSeenLayoutVersionRef.current = event.layoutVersion;
        invalidateLayoutCache();
        // Offsets moved → the total content size may have too, which can put
        // a stationary user inside (or outside) an edge threshold.
        checkEdgeCallbacksRef.current();
      }
      // Warm the layout cache for the incoming range before React renders it.
      hydrateFromSlab(event.start, event.end);
      latestRangeRef.current = {start: event.start, end: event.end};

      const update = (prev: {start: number; end: number; layoutVersion: number} | null) =>
        prev != null &&
        prev.start === event.start &&
        prev.end === event.end &&
        prev.layoutVersion === event.layoutVersion
          ? prev
          : {start: event.start, end: event.end, layoutVersion: event.layoutVersion};

      if (isPrewarmingRangeRef.current) {
        lastPrewarmRangeRef.current = {
          start: event.start,
          end: event.end,
          layoutVersion: event.layoutVersion,
        };
        setPrewarmRange(update);
        return;
      }
      setRange(update);

      if (offsetConsumed) {
        // Range-cadence bookkeeping — what per-tick scroll events drive in
        // the JS-thread mode. Viewability additionally gets throttled UI
        // wakeups (worklet) because items can cross thresholds without the
        // range moving; gesture settles re-sync the exact rest offset.
        evaluateViewabilityRef.current();
        checkEdgeCallbacksRef.current();
        captureMvcpAnchorRef.current(engineOffset);
        if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
          // Blank-area sample at range cadence. hydrateFromSlab above just
          // refreshed totalSize in the layout cache, and per-item reads hit
          // the freshly-hydrated entries.
          const viewportH = viewportSizeRef.current.height;
          if (viewportH > 0) {
            const visTop = Math.max(0, engineOffset);
            const visBottom = Math.min(
              engineOffset + viewportH,
              layoutCacheRef.current.totalSize,
            );
            if (visBottom > visTop) {
              let blankPx: number;
              if (end < start) {
                blankPx = visBottom - visTop;
              } else {
                const coveredTop = readItemOffset(start);
                const coveredBottom = readItemOffset(end) + readItemSize(end);
                blankPx =
                  Math.max(0, coveredTop - visTop) + Math.max(0, visBottom - coveredBottom);
              }
              NitroListPerfMonitor.recordScrollSample(blankPx);
            }
          }
        }
      }
    },
    [invalidateLayoutCache, hydrateFromSlab, readItemOffset, readItemSize],
  );
  const onRangeChangeCb = useMemo(() => callback(handleRangeChange), [handleRangeChange]);

  // Last engine offset the JS side actually pushed over JSI. Lets the
  // layoutVersion effect skip its push when the engine already holds this
  // exact value (a version bump alone doesn't move the offset — the
  // legitimate divergence is effectivePaddingTop changing). The F4 worklet
  // pushes on the UI thread without updating this ref, so the gate only ever
  // skips pushes the native side would dedupe as no-ops anyway.
  const lastPushedEngineOffsetRef = useRef<number | null>(null);

  // F3: scroll + range readback in ONE synchronous JSI call — replaces the
  // `setScrollOffset → async onRangeChange → fillLayoutSlab` pipeline on the
  // scroll hot path. The range (when it moved) lands in the same JS tick as
  // the scroll event: no callback enqueue, no second JSI call, one native
  // lock. `onRangeChange` remains the push channel for native-initiated
  // changes (prop commits, measurement batches).
  const applyScrollOffsetSync = useCallback(
    (engineOffset: number) => {
      const hybrid = hybridRef.current;
      if (!hybrid) return;
      let slab = slabRef.current;
      let written = hybrid.setScrollOffsetAndFill(engineOffset, slab.buffer);
      // Offset lands on the first call even when the slab retry below runs.
      lastPushedEngineOffsetRef.current = engineOffset;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) {
        // Slab smaller than the new range — grow and retry (the offset was
        // already applied by the first call).
        slabRef.current = new Float64Array(slab.length * 2);
        slab = slabRef.current;
        written = hybrid.setScrollOffsetAndFill(engineOffset, slab.buffer);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        if (written < 0) return;
      }
      if (written === 0) {
        // Range and layoutVersion unchanged — nothing async is coming for
        // this dispatch; clear the latency mark so a later
        // measurement-initiated range event can't consume it (B0.2).
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.clearScrollDispatchMark();
        return;
      }
      const version = slab[0] | 0;
      const start = slab[2] | 0;
      const end = slab[3] | 0;
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        // Sync delivery consumes the scroll-dispatch mark with ~0ms latency —
        // exactly the before/after the rangeLatency metric exists to show.
        NitroListPerfMonitor.recordRangeEvent();
        if (end >= start) {
          NitroListPerfMonitor.recordFirstRange(mountTimestampRef.current);
        }
      }
      if (version !== lastSeenLayoutVersionRef.current) {
        lastSeenLayoutVersionRef.current = version;
        invalidateLayoutCache();
        checkEdgeCallbacksRef.current();
      }
      writeSlabToCache(slab, written);
      latestRangeRef.current = {start, end};
      const update = (prev: {start: number; end: number; layoutVersion: number} | null) =>
        prev != null && prev.start === start && prev.end === end && prev.layoutVersion === version
          ? prev
          : {start, end, layoutVersion: version};
      if (isPrewarmingRangeRef.current) {
        lastPrewarmRangeRef.current = {start, end, layoutVersion: version};
        setPrewarmRange(update);
        return;
      }
      setRange(update);
    },
    [invalidateLayoutCache, writeSlabToCache],
  );

  // Sticky-index bookkeeping shared by the JS driver and the UI-runtime
  // wakeups (worklet notifies through scheduleOnRN — needs a stable target).
  const onChangeStickyIndexRef = useRef(onChangeStickyIndex);
  useEffect(() => {
    onChangeStickyIndexRef.current = onChangeStickyIndex;
  });
  const applyStickyIndex = useCallback((index: number) => {
    if (stickyIndexRef.current === index) return;
    stickyIndexRef.current = index;
    setStickyIndexState(index);
    onChangeStickyIndexRef.current?.(index);
  }, []);

  // W2: one-shot sticky recompute on the UI runtime — for sticky-affecting
  // changes that arrive WITHOUT a scroll tick while the UI driver owns the
  // overlay (layoutVersion bumps from measurement batches, config changes).
  // The worklet reads the engine offset from its own runtime's shared value
  // and the layout through host functions — nothing stale, and nothing is
  // ever read back on the JS thread.
  const scheduleStickyRecomputeOnUi = useCallback(() => {
    const hybrid = attachedHybrid;
    if (hybrid == null || stickyIndices.length === 0) return;
    const indices = stickyIndices;
    const bar = stickyOffset;
    const offsetSv = uiScrollOffsetSv;
    const translateYSv = stickyTranslateYSv;
    const activeIndexSv = uiStickyIndexSv;
    const notify = applyStickyIndex;
    scheduleOnUI(() => {
      'worklet';
      driveStickyOnUi(hybrid, offsetSv.value, indices, bar, translateYSv, activeIndexSv, notify);
    });
  }, [
    attachedHybrid,
    stickyIndices,
    stickyOffset,
    applyStickyIndex,
    uiScrollOffsetSv,
    stickyTranslateYSv,
    uiStickyIndexSv,
  ]);

  const updateSticky = useCallback(
    (offset: number) => {
      if (stickyIndices.length === 0 || !hybridRef.current) {
        // The worklet is not driving sticky here (no indices / no hybrid), so
        // this write can't race it. Without it, removing and re-adding the
        // same sticky config would leave a stale UI-side baseline that
        // swallows the worklet's next "index changed" notification.
        uiStickyIndexSv.value = -1;
        applyStickyIndex(-1);
        return;
      }
      if (uiThreadDriverActiveRef.current) {
        // W2: the UI runtime owns the overlay — route this trigger there.
        scheduleStickyRecomputeOnUi();
        return;
      }
      const result = computeSticky(
        offset,
        stickyIndices,
        stickyOffset,
        readItemOffset,
        readItemSize,
      );
      applyStickyIndex(result.index);
      // W0: dedupe against the last JS-written value — reading
      // translateY.value here would block the JS thread on the UI thread.
      if (lastJsStickyTyRef.current !== result.translateY) {
        lastJsStickyTyRef.current = result.translateY;
        stickyTranslateYSv.value = result.translateY;
      }
    },
    [
      stickyIndices,
      stickyOffset,
      applyStickyIndex,
      scheduleStickyRecomputeOnUi,
      readItemOffset,
      readItemSize,
      stickyTranslateYSv,
      uiStickyIndexSv,
    ],
  );

  const evaluateViewability = useCallback(() => {
    const cb = onViewableItemsChanged;
    const config = viewabilityConfig;
    const viewable = viewableMapRef.current;
    const pending = pendingMapRef.current;
    if (!cb || !config) {
      // Nothing to report — but if we previously had viewable items and the
      // callback was just removed, don't bother emitting fake "no longer viewable"
      // events; just clear bookkeeping.
      if (viewable.size > 0) viewable.clear();
      if (pending.size > 0) pending.clear();
      return;
    }
    const hybrid = hybridRef.current;
    const viewportH = viewportSizeRef.current.height;
    // Engine works in NitroListView-local coords; paddingTop shifts the
    // scrollable content but doesn't affect item offsets.
    const offset = lastScrollOffsetRef.current - effectivePaddingTopRef.current;
    if (!hybrid || viewportH <= 0) return;

    const minimumViewTime = config.minimumViewTime ?? 0;
    const waitForInteraction = config.waitForInteraction ?? false;

    const start = Math.max(0, range.start);
    const end = Math.min(range.end, items.length - 1);

    // Debounce-by-distance: while scrolling smoothly, sub-MIN_OFFSET_DELTA
    // ticks cannot move any item across its viewability threshold. The full
    // evaluation still runs on range/layoutVersion changes (handled by the
    // useEffect[evaluateViewability]) and any time a pending timer fires.
    const last = lastViewabilityEvalRef.current;
    const layoutVersion = range.layoutVersion;
    const rangeMoved = last.start !== start || last.end !== end;
    const layoutShifted = last.layoutVersion !== layoutVersion;
    const offsetDelta = Math.abs(offset - last.offset);
    const hasPending = pending.size > 0;
    if (
      !rangeMoved &&
      !layoutShifted &&
      !hasPending &&
      Number.isFinite(last.offset) &&
      offsetDelta < VIEWABILITY_MIN_OFFSET_DELTA
    ) {
      return;
    }
    last.offset = offset;
    last.start = start;
    last.end = end;
    last.layoutVersion = layoutVersion;

    const scratch = viewabilityScratchRef.current as unknown as {
      potential: Set<number>;
      pendingKeysSnapshot: number[];
      removed: NitroListViewToken<T>[];
      newlyViewable: NitroListViewToken<T>[];
    };
    const potential = scratch.potential;
    potential.clear();
    if (!waitForInteraction || hasInteractedRef.current) {
      for (let i = start; i <= end; i++) {
        const top = readItemOffset(i);
        const h = readItemSize(i);
        if (isItemViewable(top, h, offset, viewportH, config)) {
          potential.add(i);
        }
      }
    }

    const now = Date.now();

    // Drop pending entries that are no longer potential. Snapshot the keys
    // into a reusable array (we mutate `pending` during the loop).
    const pendingKeys = scratch.pendingKeysSnapshot;
    pendingKeys.length = 0;
    for (const idx of pending.keys()) pendingKeys.push(idx);
    for (let i = 0; i < pendingKeys.length; i++) {
      const idx = pendingKeys[i];
      if (!potential.has(idx)) pending.delete(idx);
    }

    // Promote potential -> viewable based on minimumViewTime.
    const newlyViewable = scratch.newlyViewable;
    newlyViewable.length = 0;
    for (const idx of potential) {
      if (viewable.has(idx)) continue;
      if (minimumViewTime <= 0) {
        pending.delete(idx);
      } else {
        const since = pending.get(idx);
        if (since == null) {
          pending.set(idx, now);
          continue;
        }
        if (now - since < minimumViewTime) continue;
        pending.delete(idx);
      }
      const item = items[idx];
      const key = keyExtractor ? keyExtractor(item, idx) : String(idx);
      newlyViewable.push({item, key, index: idx, isViewable: true, timestamp: now});
    }

    // Detect indices that left the viewable set.
    const removed = scratch.removed;
    removed.length = 0;
    for (const [idx, tok] of viewable) {
      if (!potential.has(idx)) {
        removed.push({...tok, isViewable: false, timestamp: now});
      }
    }
    for (let i = 0; i < removed.length; i++) {
      const tok = removed[i];
      if (tok.index != null) viewable.delete(tok.index);
    }
    for (let i = 0; i < newlyViewable.length; i++) {
      const tok = newlyViewable[i];
      if (tok.index != null) viewable.set(tok.index, tok);
    }

    // Reschedule the debounce timer for any items still in pending.
    if (viewabilityTimerRef.current != null) {
      clearTimeout(viewabilityTimerRef.current);
      viewabilityTimerRef.current = null;
    }
    if (pending.size > 0 && minimumViewTime > 0) {
      let earliest = Infinity;
      for (const since of pending.values()) {
        const deadline = since + minimumViewTime;
        if (deadline < earliest) earliest = deadline;
      }
      const delay = Math.max(0, earliest - now);
      viewabilityTimerRef.current = setTimeout(() => {
        viewabilityTimerRef.current = null;
        evaluateViewabilityRef.current();
      }, delay);
    }

    if (removed.length > 0 || newlyViewable.length > 0) {
      const viewableItems = Array.from(viewable.values());
      cb({viewableItems, changed: [...removed, ...newlyViewable]});
    }
  }, [
    viewabilityConfig,
    onViewableItemsChanged,
    range,
    items,
    keyExtractor,
    readItemOffset,
    readItemSize,
  ]);

  const previousItemsRef = useRef<ReadonlyArray<T>>(items);
  const previousDataVersionRef = useRef<unknown>(dataVersion);
  useEffect(() => {
    evaluateViewabilityRef.current = evaluateViewability;
    const versionChanged = !Object.is(previousDataVersionRef.current, dataVersion);
    if (previousItemsRef.current !== items || versionChanged) {
      const prevItems = previousItemsRef.current;
      previousItemsRef.current = items;
      previousDataVersionRef.current = dataVersion;
      // Structural = the index↔item mapping moved (or we can't prove it
      // didn't). A new array reference with the same keys — the common
      // selector/`.map()` re-wrap — is a content-only update: every measured
      // size, estimate, viewability token and the layout cache remain valid,
      // so resetting them (the previous behavior) was pure churn plus a
      // spurious re-measure pass.
      const keysChanged = keyExtractor
        ? didKeysChangeStructurally(prevItems, items, keyExtractor)
        : true; // no keys — identity is the index itself; keep the legacy full reset
      if (versionChanged || keysChanged) {
        // MVCP data trigger: snapshot the anchor before wiping layout state.
        // Its offset was captured on the last real scroll — the pre-change
        // baseline. Requires keys to re-identify the item afterwards.
        const mvcpAnchorBefore =
          mvcpStateRef.current.enabled && keyExtractor != null ? mvcpStateRef.current.anchor : null;
        // Index i may now hold a different item than the one measured there.
        // Wipe the native sizes too (stale measured heights would leave
        // offsets/scrollToIndex wrong until every cell happened to remount) —
        // but only when we *proved* remapping; without a keyExtractor the
        // index is the identity and per-index sizes are still the best guess.
        if (versionChanged || keyExtractor) {
          hybridRef.current?.resetItemSizes();
          if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
        }
        // Re-find the anchored item by key and compensate the scroll by how
        // far it moved (prepend/insert pushes it down; removal above pulls it
        // up). Offsets here are type-mean estimates post-reset — the size
        // trigger refines the position as real measurements stream back in.
        if (mvcpAnchorBefore != null && mvcpAnchorBefore.key != null && keyExtractor) {
          let newIndex = -1;
          const sameIndexItem = items[mvcpAnchorBefore.index];
          if (
            sameIndexItem !== undefined &&
            keyExtractor(sameIndexItem, mvcpAnchorBefore.index) === mvcpAnchorBefore.key
          ) {
            newIndex = mvcpAnchorBefore.index;
          } else {
            for (let i = 0; i < items.length; i++) {
              if (keyExtractor(items[i], i) === mvcpAnchorBefore.key) {
                newIndex = i;
                break;
              }
            }
          }
          if (newIndex >= 0) {
            invalidateLayoutCache();
            const offsetAfter = readItemOffset(newIndex);
            const diff = offsetAfter - mvcpAnchorBefore.offset;
            // Seed the anchor with the pre-change baseline; the correction
            // below advances it by `diff` (→ offsetAfter). The next real
            // scroll event re-anchors from scratch anyway.
            mvcpStateRef.current.anchor = {
              index: newIndex,
              key: mvcpAnchorBefore.key,
              offset: mvcpAnchorBefore.offset,
            };
            if (Math.abs(diff) > MVCP_POSITION_EPSILON) {
              applyMvcpCorrectionRef.current(diff);
            } else {
              mvcpStateRef.current.anchor.offset = offsetAfter;
            }
          } else {
            // Anchored item no longer exists — nothing to hold on to.
            mvcpStateRef.current.anchor = null;
          }
        }
        viewableMapRef.current = new Map();
        pendingMapRef.current = new Map();
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
        // Indices now map to potentially different items; drop the layout cache
        // and force the next viewability evaluation to do a full pass.
        invalidateLayoutCache();
        lastViewabilityEvalRef.current = {
          offset: Number.NaN,
          start: -1,
          end: -2,
          layoutVersion: -1,
        };
        if (viewabilityTimerRef.current != null) {
          clearTimeout(viewabilityTimerRef.current);
          viewabilityTimerRef.current = null;
        }
      } else {
        // Content-only update: refresh the item refs stored in viewability
        // tokens so a later "no longer viewable" emission carries the current
        // object, not the pre-update one.
        const viewable = viewableMapRef.current;
        for (const [idx, tok] of viewable) {
          const item = items[idx];
          if (item !== undefined && tok.item !== item) {
            viewable.set(idx, {...tok, item});
          }
        }
      }
    }
    // Re-run on every dep change (range, items, config, callback) so
    // consumers don't miss the initial pass after mount and so changes to
    // thresholds take effect without waiting for a scroll.
    evaluateViewability();
  }, [
    evaluateViewability,
    items,
    dataVersion,
    keyExtractor,
    invalidateLayoutCache,
    readItemOffset,
    cancelFlingPrewarm,
  ]);

  // Cleanup any pending timer on unmount.
  useEffect(
    () => () => {
      if (viewabilityTimerRef.current != null) {
        clearTimeout(viewabilityTimerRef.current);
        viewabilityTimerRef.current = null;
      }
    },
    [],
  );

  // Re-anchor MVCP to the first fully-visible item at the given engine
  // offset. In JS-driver mode this runs per scroll tick; under F4 it runs on
  // range wakeups and gesture settles — either way the captured offset
  // predates the mutations it will later compensate for.
  const captureMvcpAnchor = useCallback(
    (engineOffset: number) => {
      const mvcp = mvcpStateRef.current;
      if (!mvcp.enabled) return;
      const r = latestRangeRef.current;
      let anchorIndex = -1;
      for (let i = Math.max(0, r.start); i <= r.end; i++) {
        if (readItemOffset(i) >= engineOffset) {
          anchorIndex = i;
          break;
        }
      }
      if (anchorIndex < 0) anchorIndex = r.end;
      if (anchorIndex >= 0) {
        const anchorItem = items[anchorIndex];
        mvcp.anchor = {
          index: anchorIndex,
          key:
            keyExtractor && anchorItem !== undefined
              ? keyExtractor(anchorItem, anchorIndex)
              : null,
          offset: readItemOffset(anchorIndex),
        };
      }
    },
    [items, keyExtractor, readItemOffset],
  );
  useEffect(() => {
    captureMvcpAnchorRef.current = captureMvcpAnchor;
  }, [captureMvcpAnchor]);

  const handleOuterScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const scrollY = e.nativeEvent.contentOffset.y;
      // Drain this frame's pending measurements *silently* before anything
      // else: the sync fill below returns the range already computed with the
      // fresh sizes, so the batch's own emission would be a redundant async
      // second delivery. Ordering constraints: (a) before the MVCP guard
      // check, so a correction triggered by this drain arms the guard that
      // must swallow the current (pre-correction) event; (b) skipped under
      // the F4 UI-thread driver, where no sync fill follows — there the
      // emitting rAF flush stays the only delivery channel. Measurements
      // landing outside scroll keep the emitting rAF fallback (it is only
      // cancelled when this drain consumed the buffer).
      if (!uiThreadDriverActiveRef.current && pendingSizesRef.current.count > 0) {
        flushPendingItemSizes(false);
      }
      // MVCP stale-event guard: a scroll event sampled *before* a
      // programmatic correction can arrive *after* it (bridge latency) and
      // would push the pre-correction offset back into the engine, visually
      // undoing the correction. Events on the stale side of the midpoint are
      // swallowed whole until a fresh-side event or the TTL disarms.
      const guard = mvcpGuardRef.current;
      if (guard != null) {
        if (Date.now() > guard.expiresAt) {
          mvcpGuardRef.current = null;
        } else if (guard.staleBelow ? scrollY < guard.threshold : scrollY > guard.threshold) {
          return;
        } else {
          mvcpGuardRef.current = null;
        }
      }
      if (isPrewarmingRangeRef.current) {
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        setPrewarmRange(null);
      }
      // Launch-velocity sample (dp/s) for fling-destination prediction.
      const velocitySample = scrollVelocityRef.current;
      const nowMs = Date.now();
      const dtMs = nowMs - velocitySample.time;
      if (dtMs > 200) {
        velocitySample.velocity = 0; // new gesture — stale velocity says nothing
      } else if (dtMs >= 1) {
        velocitySample.velocity = ((scrollY - velocitySample.offset) / dtMs) * 1000;
      }
      velocitySample.offset = scrollY;
      velocitySample.time = nowMs;
      lastScrollOffsetRef.current = scrollY;
      // W4: consumer-provided shared-value mirror of the absolute offset
      // (JS→UI write — cheap; under F4 the worklet writes it instead).
      if (scrollOffsetSharedValue != null) {
        scrollOffsetSharedValue.value = scrollY;
      }
      const engineOffset = scrollY - effectivePaddingTopRef.current;
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        // Timestamp the dispatch so the range delivery can be timed — the
        // sync path below should consume it at ~0ms (that's F3's win).
        NitroListPerfMonitor.markScrollDispatch();
      }
      if (uiThreadDriverActiveRef.current) {
        // F4: the UI-thread worklet is the single offset driver — a JS write
        // here could push a STALE offset over a fresher worklet one (JS
        // events lag under congestion). Ranges arrive via onRangeChange.
      } else {
        applyScrollOffsetSync(engineOffset);
      }
      updateSticky(engineOffset);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      // Re-anchor MVCP to the first fully-visible item at this offset. Scroll
      // events precede the mutations we compensate for, so the captured
      // offset is the pre-mutation baseline by construction.
      captureMvcpAnchor(engineOffset);
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        // Blank-area sample: visible viewport interval vs the interval covered
        // by the *mounted* range. Reads hit the layout cache (no JSI in the
        // common case) and the whole block strips from release builds.
        const viewportH = viewportSizeRef.current.height;
        if (viewportH > 0) {
          const visTop = Math.max(0, engineOffset);
          const visBottom = Math.min(engineOffset + viewportH, readTotalSize());
          if (visBottom > visTop) {
            const r = latestRangeRef.current;
            let blankPx: number;
            if (r.end < r.start) {
              blankPx = visBottom - visTop;
            } else {
              const coveredTop = readItemOffset(r.start);
              const coveredBottom = readItemOffset(r.end) + readItemSize(r.end);
              blankPx =
                Math.max(0, coveredTop - visTop) + Math.max(0, visBottom - coveredBottom);
            }
            NitroListPerfMonitor.recordScrollSample(blankPx);
          }
        }
      }
      userOnScroll?.(e);
    },
    [
      userOnScroll,
      updateSticky,
      applyScrollOffsetSync,
      flushPendingItemSizes,
      captureMvcpAnchor,
      readItemOffset,
      readItemSize,
      readTotalSize,
      scrollOffsetSharedValue,
    ],
  );

  const handleOuterLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const {width, height} = e.nativeEvent.layout;
      viewportSizeRef.current = {width, height};
      hybridRef.current?.setViewport(width, height);
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      // R3: width just became known (or changed buckets) — seed type means
      // for this measurement context; before this, the first push had no
      // width to key the cache with.
      seedTypeMeansFromCache();
      updateAlignPadRef.current();
      // Layout change can affect sticky push (since viewport shifts items).
      updateSticky(lastScrollOffsetRef.current - effectivePaddingTopRef.current);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
    },
    [updateSticky, seedTypeMeansFromCache],
  );

  // Applies any MVCP adjustment deferred during the gesture. Routed through
  // applyMvcpCorrectionRef with activity flags already cleared, so it takes
  // the immediate path (and re-checks the at-top guard / clamping there).
  const flushPendingMvcpAdjust = useCallback(() => {
    const activity = scrollActivityRef.current;
    const pending = activity.pendingAdjust;
    if (pending === 0) return;
    activity.pendingAdjust = 0;
    if (Math.abs(pending) > MVCP_POSITION_EPSILON) {
      // The anchor's baseline already advanced when the diffs were measured —
      // only the scroll needs to catch up now. Compensate the double-advance
      // applyMvcpCorrection would do.
      const anchor = mvcpStateRef.current.anchor;
      if (anchor != null) anchor.offset -= pending;
      applyMvcpCorrectionRef.current(pending);
    }
  }, []);

  const handleScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // A momentum-end event can get lost (e.g. interrupted fling); make sure
      // stale deferred adjustments don't leak into the new gesture.
      flushPendingMvcpAdjust();
      const activity = scrollActivityRef.current;
      activity.dragging = true;
      activity.momentum = false;
      // A new gesture invalidates any fling-destination prewarm in flight —
      // including a partially-admitted one (the admission loop dies with it).
      cancelFlingPrewarm();
      if (uiThreadDriverActiveRef.current && isPrewarmingRangeRef.current) {
        // F4 v2: no per-tick JS scroll events will arrive to break a
        // scrollToIndex prewarm — the gesture itself is the "real scroll
        // begins" signal that re-routes ranges into the live window.
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
      }
      if (!isPrewarmingRangeRef.current) {
        setPrewarmRange(null);
      }
      if (!hasInteractedRef.current) {
        hasInteractedRef.current = true;
        // If `waitForInteraction` was on, items can now be reported.
        evaluateViewabilityRef.current();
      }
      onScrollBeginDrag?.(e);
    },
    [onScrollBeginDrag, flushPendingMvcpAdjust, cancelFlingPrewarm],
  );
  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const activity = scrollActivityRef.current;
      activity.dragging = false;
      if (uiThreadDriverActiveRef.current) {
        // F4 v2 (W3): the fling decision belongs to the worklet's onEndDrag —
        // its velocity estimate lives on the UI thread (the JS estimator is
        // stale at range cadence). It schedules settleUiEndDrag with the
        // real values; here we only re-sync the release offset.
        lastScrollOffsetRef.current = e.nativeEvent.contentOffset.y;
      } else {
        const launchVelocity = scrollVelocityRef.current.velocity;
        if (Math.abs(launchVelocity) >= FLING_MIN_VELOCITY_DP_S) {
          // Fling begins: pre-render the predicted landing zone so its cells
          // mount and measure during the deceleration (300–1500ms of budget).
          prewarmFlingDestinationRef.current();
        } else {
          // No momentum expected — settle any deferred MVCP adjustment now.
          flushPendingMvcpAdjust();
        }
      }
      onScrollEndDrag?.(e);
    },
    [onScrollEndDrag, flushPendingMvcpAdjust],
  );
  const handleMomentumScrollBegin = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollActivityRef.current.momentum = true;
      onMomentumScrollBegin?.(e);
    },
    [onMomentumScrollBegin],
  );
  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollActivityRef.current.momentum = false;
      // The fling landed — the live range now covers the destination; the
      // prewarm union served its purpose (any admission still in flight is
      // pointless now).
      cancelFlingPrewarm();
      if (!isPrewarmingRangeRef.current) {
        setPrewarmRange(null);
      }
      const uiDriven = uiThreadDriverActiveRef.current;
      if (uiDriven) {
        // F4 v2 settle: the final stretch can end between range emissions —
        // re-sync the exact rest offset BEFORE flushing MVCP (the correction
        // math reads lastScrollOffsetRef).
        lastScrollOffsetRef.current = e.nativeEvent.contentOffset.y;
      }
      flushPendingMvcpAdjust();
      if (uiDriven) {
        const engineOffset = lastScrollOffsetRef.current - effectivePaddingTopRef.current;
        evaluateViewabilityRef.current();
        checkEdgeCallbacksRef.current();
        captureMvcpAnchor(engineOffset);
      }
      onMomentumScrollEnd?.(e);
    },
    [onMomentumScrollEnd, flushPendingMvcpAdjust, cancelFlingPrewarm, captureMvcpAnchor],
  );

  // ---- F4 v2: UI-thread scroll driver (experimental, behind a prop) ---------
  // The worklet is the SINGLE offset driver: it feeds the engine at UI-frame
  // cadence and (with sticky headers) positions the overlay right here on
  // the UI runtime. The JS thread is NOT woken per tick — ranges arrive via
  // onRangeChange (which native emits only on real change, carrying the
  // offset they were computed at). Optional per-feature wakeups: a throttled
  // viewability tick, one settle per drag end, and — only when the consumer
  // insists on a JS onScroll — one wakeup per tick (documented slow path).

  // JS-side landing points for the worklet's scheduleOnRN calls. All keep
  // stable identities (state through refs) so the handler doesn't rebuild —
  // every rebuild re-serializes the closure onto the UI runtime.
  const settleUiViewabilityTick = useCallback((absoluteY: number) => {
    lastScrollOffsetRef.current = absoluteY;
    evaluateViewabilityRef.current();
  }, []);
  const settleUiEndDrag = useCallback(
    (velocityDpS: number, absoluteY: number) => {
      lastScrollOffsetRef.current = absoluteY;
      const sample = scrollVelocityRef.current;
      sample.velocity = velocityDpS;
      sample.offset = absoluteY;
      sample.time = Date.now();
      if (Math.abs(velocityDpS) >= FLING_MIN_VELOCITY_DP_S) {
        // Fling begins: pre-render the predicted landing zone so its cells
        // mount and measure during the deceleration (300–1500ms of budget).
        prewarmFlingDestinationRef.current();
      } else {
        // No momentum expected — settle any deferred MVCP adjustment now.
        flushPendingMvcpAdjust();
      }
    },
    [flushPendingMvcpAdjust],
  );
  const userOnScrollRef = useRef(userOnScroll);
  useEffect(() => {
    userOnScrollRef.current = userOnScroll;
  });
  const emitUserScrollFromUi = useCallback((y: number) => {
    lastScrollOffsetRef.current = y;
    userOnScrollRef.current?.({
      nativeEvent: {contentOffset: {x: 0, y}},
    } as NativeSyntheticEvent<NativeScrollEvent>);
  }, []);

  const hasUserOnScroll = userOnScroll != null;
  const hasViewabilityWakeups = onViewableItemsChanged != null && viewabilityConfig != null;
  const stickyCount = stickyIndices.length;

  const uiThreadScrollHandler = useAnimatedScrollHandler<UiScrollContext>(
    {
      onScroll: (event, ctx) => {
        'worklet';
        const y = event.contentOffset.y;
        const engineOffset = y - uiPaddingTopSv.value;
        if (attachedHybrid != null) {
          // Sync Nitro call from the UI runtime — hybrid methods are host
          // functions (Nitro boxes the object across runtimes through the
          // worklets custom-serializable registry); the wrapper state is
          // lock-protected.
          attachedHybrid.setScrollOffset(engineOffset);
        }
        // Same-runtime mirror for one-shot recomputes (sticky after
        // stationary layout changes) — never read back from JS.
        uiScrollOffsetSv.value = engineOffset;
        if (scrollOffsetSharedValue != null) {
          scrollOffsetSharedValue.value = y;
        }
        // W3: launch-velocity estimate with UI-thread timestamps — no bridge
        // jitter. Same delta estimator as the JS path (event.velocity's sign
        // convention differs across platforms).
        const now = Date.now();
        const lastTime = ctx.lastTime;
        const lastY = ctx.lastY;
        if (lastTime == null || lastY == null || now - lastTime > 200) {
          ctx.velocity = 0; // new gesture — stale velocity says nothing
        } else if (now - lastTime >= 1) {
          ctx.velocity = ((y - lastY) / (now - lastTime)) * 1000;
        }
        ctx.lastY = y;
        ctx.lastTime = now;
        // W2: sticky positioned here, per tick — pixel-perfect even with the
        // JS thread saturated (it used to freeze along with it).
        if (stickyCount > 0 && attachedHybrid != null) {
          driveStickyOnUi(
            attachedHybrid,
            engineOffset,
            stickyIndices,
            stickyOffset,
            stickyTranslateYSv,
            uiStickyIndexSv,
            applyStickyIndex,
          );
        }
        // W1: throttled viewability wakeups — items can cross a visibility
        // threshold without the engaged range moving (drawDistance slack).
        if (hasViewabilityWakeups) {
          const lastVt = ctx.lastViewabilityTime;
          const lastVy = ctx.lastViewabilityY;
          if (
            lastVt == null ||
            lastVy == null ||
            (now - lastVt >= UI_VIEWABILITY_MIN_INTERVAL_MS &&
              Math.abs(y - lastVy) >= VIEWABILITY_MIN_OFFSET_DELTA)
          ) {
            ctx.lastViewabilityTime = now;
            ctx.lastViewabilityY = y;
            scheduleOnRN(settleUiViewabilityTick, y);
          }
        }
        if (onScrollWorklet != null) {
          onScrollWorklet(event);
        }
        if (hasUserOnScroll) {
          // Documented slow path: a JS onScroll costs one wakeup per tick.
          scheduleOnRN(emitUserScrollFromUi, y);
        }
      },
      onEndDrag: (event, ctx) => {
        'worklet';
        // W3: ONE wakeup per gesture end — JS decides prewarm-vs-MVCP-flush
        // with the UI-thread velocity (its own estimator is range-cadence
        // stale in this mode).
        scheduleOnRN(settleUiEndDrag, ctx.velocity ?? 0, event.contentOffset.y);
      },
    },
    [
      attachedHybrid,
      stickyCount,
      stickyIndices,
      stickyOffset,
      hasUserOnScroll,
      hasViewabilityWakeups,
      onScrollWorklet,
      scrollOffsetSharedValue,
      applyStickyIndex,
      settleUiEndDrag,
      settleUiViewabilityTick,
      emitUserScrollFromUi,
      uiPaddingTopSv,
      uiScrollOffsetSv,
      stickyTranslateYSv,
      uiStickyIndexSv,
    ],
  );

  const getMaxScrollOffset = useCallback(() => {
    const totalSize = readTotalSize();
    const viewportH = viewportSizeRef.current.height;
    const totalContent = effectivePaddingTopRef.current + totalSize + footerSize + paddingBottom;
    return Math.max(0, totalContent - viewportH);
  }, [footerSize, paddingBottom, readTotalSize]);

  const clampScrollOffset = useCallback(
    (offset: number) => Math.max(0, Math.min(offset, getMaxScrollOffset())),
    [getMaxScrollOffset],
  );

  // alignItemsAtEnd spacer: pins short content to the bottom, collapses to 0
  // once the content outgrows the viewport. Recomputed on layout/size/data
  // changes; setState bails when unchanged.
  const updateAlignPad = useCallback(() => {
    if (!alignItemsAtEnd) {
      setAlignPad(0);
      return;
    }
    const viewportH = viewportSizeRef.current.height;
    const content = paddingTop + headerSize + readTotalSize() + footerSize + paddingBottom;
    setAlignPad(Math.max(0, Math.round((viewportH - content) * 8) / 8));
  }, [alignItemsAtEnd, paddingTop, headerSize, footerSize, paddingBottom, readTotalSize]);
  updateAlignPadRef.current = updateAlignPad;
  useEffect(() => {
    updateAlignPad();
  }, [updateAlignPad, range.layoutVersion, itemCount]);

  const handleHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    setHeaderSize((prev) =>
      Math.abs(prev - height) > MEASUREMENT_NOISE_EPSILON_DP ? height : prev,
    );
  }, []);
  const handleFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    setFooterSize((prev) =>
      Math.abs(prev - height) > MEASUREMENT_NOISE_EPSILON_DP ? height : prev,
    );
  }, []);
  // Removing a slot must also remove its contribution to the math (§9.18).
  useEffect(() => {
    if (ListHeaderComponent == null) setHeaderSize(0);
  }, [ListHeaderComponent]);
  useEffect(() => {
    if (ListFooterComponent == null) setFooterSize(0);
  }, [ListFooterComponent]);

  const scrollToAbsoluteOffset = useCallback(
    (offset: number, animated: boolean) => {
      const target = clampScrollOffset(offset);
      lastScrollOffsetRef.current = target;
      const engineOffset = target - effectivePaddingTopRef.current;
      // Keep the UI-runtime mirror fresh for one-shot sticky recomputes —
      // programmatic scrolls don't necessarily produce scroll events.
      uiScrollOffsetSv.value = engineOffset;
      // Programmatic scrolls ride the same F3 sync boundary as gesture
      // events: the engaged range (and layout cache) land in this tick, so
      // updateSticky/viewability below already see them — no async
      // onRangeChange hop, which native keeps mute for ranges delivered here.
      applyScrollOffsetSync(engineOffset);
      updateSticky(engineOffset);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      scrollRef.current?.scrollTo({y: target, animated});
      return target;
    },
    [applyScrollOffsetSync, clampScrollOffset, updateSticky, uiScrollOffsetSv],
  );

  useEffect(() => {
    scrollToEndForMaintainRef.current = (animated: boolean) => {
      scrollToAbsoluteOffset(getMaxScrollOffset(), animated);
    };
  }, [scrollToAbsoluteOffset, getMaxScrollOffset]);

  // MVCP correction: shift the scroll by the anchor's measured offset delta
  // and arm the stale-event guard. Routed through a ref because the flush
  // pipeline (declared before scrollToAbsoluteOffset exists) triggers it.
  useEffect(() => {
    applyMvcpCorrectionRef.current = (diff: number) => {
      // The anchor's layout offset moved by `diff` regardless of whether the
      // scroll compensates — keep its baseline true to the layout so the
      // next measured diff is against the right base.
      const anchor = mvcpStateRef.current.anchor;
      if (anchor != null) {
        anchor.offset += diff;
      }
      const activity = scrollActivityRef.current;
      if (activity.dragging || activity.momentum) {
        // A scrollTo mid-gesture kills the platform fling. Accumulate and
        // settle once at momentum end (flushPendingMvcpAdjust).
        activity.pendingAdjust += diff;
        return;
      }
      const from = lastScrollOffsetRef.current;
      // Pinned at the very top: new/growing content pushes down naturally.
      if (from <= 0) return;
      const to = scrollToAbsoluteOffset(from + diff, false);
      if (to === from) return;
      mvcpGuardRef.current = {
        threshold: from + (to - from) / 2,
        staleBelow: to > from,
        expiresAt: Date.now() + MVCP_IGNORE_SCROLL_TTL_MS,
      };
    };
  }, [scrollToAbsoluteOffset]);

  // Fling-destination prewarm: predict where the momentum will settle and
  // pre-mount that window as a `prewarmRange` (rendered in union with the
  // live range) so the landing zone measures during the deceleration —
  // LegendList had to disable exactly this for being unable to keep it
  // blank-free from the JS thread mid-frame; here it is a one-shot state
  // update that native range emission is never blocked on.
  useEffect(() => {
    prewarmFlingDestinationRef.current = () => {
      if (itemCount === 0 || isPrewarmingRangeRef.current) return;
      const viewportH = viewportSizeRef.current.height;
      if (viewportH <= 0) return;
      const velocity = scrollVelocityRef.current.velocity;
      const maxTravel = viewportH * FLING_MAX_TRAVEL_VIEWPORTS;
      const travel = Math.max(-maxTravel, Math.min(maxTravel, velocity * FLING_TRAVEL_FACTOR));
      // Inside the regular draw-ahead — nothing to pre-warm.
      if (Math.abs(travel) <= drawDistance) return;
      const destination = clampScrollOffset(lastScrollOffsetRef.current + travel);
      const destEngineTop = destination - effectivePaddingTopRef.current;
      // Largest index whose top is ≤ x (offsets are monotonic — binary search
      // over the cached/JSI reads, ~log₂(n) probes once per fling).
      const indexAtOffset = (x: number): number => {
        let lo = 0;
        let hi = itemCount - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (readItemOffset(mid) <= x) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        return lo;
      };
      let destStart = indexAtOffset(Math.max(0, destEngineTop - drawDistance));
      let destEnd = indexAtOffset(destEngineTop + viewportH + drawDistance);
      if (destEnd - destStart + 1 > FLING_PREWARM_MAX_ITEMS) {
        // Estimates gone weird — keep the strictly-visible landing window.
        destStart = indexAtOffset(Math.max(0, destEngineTop));
        destEnd = Math.min(
          destStart + FLING_PREWARM_MAX_ITEMS - 1,
          indexAtOffset(destEngineTop + viewportH),
        );
      }
      const live = latestRangeRef.current;
      if (destStart >= live.start && destEnd <= live.end) return; // already mounted
      // Budgeted admission (R1): seat the strictly-visible landing zone this
      // tick, then grow toward the full window one budget slice per frame —
      // the 300–1500ms deceleration absorbs the spread instead of a single
      // tick absorbing the whole mount burst.
      const focusStart = indexAtOffset(Math.max(0, destEngineTop));
      const focusEnd = Math.max(focusStart, indexAtOffset(destEngineTop + viewportH));
      cancelFlingPrewarm();
      const admission: NonNullable<typeof flingAdmissionRef.current> = {
        target: {start: destStart, end: destEnd},
        focus: {start: focusStart, end: focusEnd},
        admitted: null,
        direction: travel >= 0 ? 1 : -1,
        rafId: null,
      };
      flingAdmissionRef.current = admission;
      const admitSlice = () => {
        if (flingAdmissionRef.current !== admission) return; // cancelled/replaced
        admission.admitted = growAdmittedRange(
          admission.target,
          admission.focus,
          admission.admitted,
          PREWARM_ADMISSION_BUDGET_ITEMS,
          admission.direction,
        );
        setPrewarmRange({
          start: admission.admitted.start,
          end: admission.admitted.end,
          layoutVersion: lastSeenLayoutVersionRef.current,
        });
        if (rangeCovers(admission.admitted, admission.target)) {
          // Fully admitted — the loop ends; the window stays mounted until
          // the fling lands (momentum end) or a new gesture clears it.
          admission.rafId = null;
          return;
        }
        admission.rafId = requestAnimationFrame(admitSlice);
      };
      admitSlice(); // first slice lands synchronously, like the old one-shot
    };
  }, [itemCount, drawDistance, clampScrollOffset, readItemOffset, cancelFlingPrewarm]);

  const prewarmRenderWindow = useCallback(
    (offset: number) => {
      const target = clampScrollOffset(offset);
      // Sync fill mounts the destination window in this same tick — the
      // prewarm branch inside applyScrollOffsetSync routes it into
      // prewarmRange. Waiting on the async callback cost a frame per
      // scrollToIndex correction pass.
      applyScrollOffsetSync(target - effectivePaddingTopRef.current);
      return target;
    },
    [applyScrollOffsetSync, clampScrollOffset],
  );

  const computeIndexScrollOffset = useCallback(
    (index: number, viewPosition: number, viewOffset: number) => {
      if (index < 0 || index >= itemCount) return null;
      const top = readItemOffset(index);
      const itemH = readItemSize(index);
      const viewportH = viewportSizeRef.current.height;
      const target =
        effectivePaddingTopRef.current + top - viewPosition * (viewportH - itemH) + viewOffset;
      return clampScrollOffset(target);
    },
    [clampScrollOffset, itemCount, readItemOffset, readItemSize],
  );

  const computeStartScrollOffset = useCallback(
    (finalOffset: number, lastAbsoluteScrollOffset: number) => {
      const viewportH = viewportSizeRef.current.height;
      const buffer = viewportH * SCROLL_TO_INDEX_BUFFER_MULTIPLIER;
      if (finalOffset > lastAbsoluteScrollOffset) {
        return clampScrollOffset(Math.max(finalOffset - buffer, lastAbsoluteScrollOffset));
      }
      return clampScrollOffset(Math.min(finalOffset + buffer, lastAbsoluteScrollOffset));
    },
    [clampScrollOffset],
  );

  const scrollToIndexPrecisely = useCallback(
    async ({
      index,
      animated = false,
      viewPosition = 0,
      viewOffset = 0,
    }: NitroListScrollToIndexParams) => {
      if (index < 0 || index >= itemCount) return;

      const commandId = ++scrollCommandIdRef.current;
      const devStartedAt = NITRO_LIST_PERF_COMPILED ? Date.now() : 0;
      let devRestarts = 0;
      let devCorrectionPasses = 0;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordScrollToIndexStart();
      isPrewarmingRangeRef.current = false;
      lastPrewarmRangeRef.current = null;
      cancelFlingPrewarm();
      setPrewarmRange(null);
      // (Type-informed estimates are maintained natively — every offset read
      // below already reflects the per-type running means.)

      let finalOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
      if (finalOffset == null) return;

      // Animated scrolls should not visibly jump through pre-render offsets.
      // They still get post-layout corrections once the destination is mounted.
      if (animated) {
        scrollToAbsoluteOffset(finalOffset, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
      } else {
        isPrewarmingRangeRef.current = true;
        try {
          let startOffset = computeStartScrollOffset(finalOffset, lastScrollOffsetRef.current);
          let initialTargetOffset = finalOffset;
          let initialStartOffset = startOffset;
          let restarts = 0;

          for (let step = 0; step < SCROLL_TO_INDEX_STEPS; step++) {
            if (commandId !== scrollCommandIdRef.current) return;

            const nextOffset = interpolateOffset(
              startOffset,
              finalOffset,
              step,
              SCROLL_TO_INDEX_STEPS,
            );
            prewarmRenderWindow(nextOffset);
            await waitForLayoutPass();
            if (commandId !== scrollCommandIdRef.current) return;

            const newFinalOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
            if (newFinalOffset == null) {
              setPrewarmRange(null);
              return;
            }

            const targetMovedOutsideInitialWindow =
              (newFinalOffset < initialTargetOffset && newFinalOffset < initialStartOffset) ||
              (newFinalOffset > initialTargetOffset && newFinalOffset > initialStartOffset);

            finalOffset = newFinalOffset;
            if (targetMovedOutsideInitialWindow && restarts < SCROLL_TO_INDEX_MAX_RESTARTS) {
              restarts++;
              devRestarts++;
              startOffset = computeStartScrollOffset(finalOffset, lastScrollOffsetRef.current);
              initialTargetOffset = finalOffset;
              initialStartOffset = startOffset;
              step = -1;
            }
          }

          for (let pass = 0; pass < SCROLL_TO_INDEX_CORRECTION_PASSES; pass++) {
            if (commandId !== scrollCommandIdRef.current) return;
            devCorrectionPasses++;
            prewarmRenderWindow(finalOffset);
            await waitForLayoutPass();
            if (commandId !== scrollCommandIdRef.current) return;

            const correctedOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
            if (correctedOffset == null) {
              setPrewarmRange(null);
              return;
            }
            if (Math.abs(correctedOffset - finalOffset) <= SCROLL_TO_INDEX_TARGET_EPSILON) {
              break;
            }
            finalOffset = correctedOffset;
          }
        } finally {
          if (commandId === scrollCommandIdRef.current) {
            isPrewarmingRangeRef.current = false;
          }
        }

        if (commandId !== scrollCommandIdRef.current) return;
        // The sync fill inside scrollToAbsoluteOffset returns 0 for the
        // duplicate offset (that range was already delivered during prewarm —
        // into prewarmRange, not `range`); seed `range` from the last prewarm
        // observation so the visible window is correct before prewarmRange
        // is cleared.
        const promoted = lastPrewarmRangeRef.current;
        lastPrewarmRangeRef.current = null;
        if (promoted) {
          setRange(promoted);
        }
        scrollToAbsoluteOffset(finalOffset, false);
        setPrewarmRange(null);
        if (NITRO_LIST_PERF_COMPILED) {
          NitroListPerfMonitor.recordScrollToIndexComplete({
            durationMs: Date.now() - devStartedAt,
            prewarmRestarts: devRestarts,
            correctionPasses: devCorrectionPasses,
            animated: false,
          });
        }
        return;
      }

      for (let pass = 0; pass < SCROLL_TO_INDEX_CORRECTION_PASSES; pass++) {
        if (commandId !== scrollCommandIdRef.current) return;
        devCorrectionPasses++;
        await waitForLayoutPass();
        if (commandId !== scrollCommandIdRef.current) return;

        const correctedOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
        if (correctedOffset == null) return;
        if (
          Math.abs(correctedOffset - lastScrollOffsetRef.current) <= SCROLL_TO_INDEX_TARGET_EPSILON
        ) {
          break;
        }
        scrollToAbsoluteOffset(correctedOffset, false);
      }
      if (NITRO_LIST_PERF_COMPILED) {
        NitroListPerfMonitor.recordScrollToIndexComplete({
          durationMs: Date.now() - devStartedAt,
          prewarmRestarts: devRestarts,
          correctionPasses: devCorrectionPasses,
          animated: true,
        });
      }
    },
    [
      computeIndexScrollOffset,
      computeStartScrollOffset,
      itemCount,
      prewarmRenderWindow,
      scrollToAbsoluteOffset,
      cancelFlingPrewarm,
    ],
  );

  // Initial-scroll convergence. The mount already seeded the engine and the
  // ScrollView with the estimated target; once the viewport is laid out (a
  // non-empty range implies setViewport ran) and the target index exists,
  // one measure-and-correct pass lands the exact offset. `settled` latches —
  // user scrolls and later data changes are never overridden.
  useEffect(() => {
    const initial = initialTargetRef.current;
    if (initial == null || initial.settled) return;
    if (range.end < 0) return; // viewport/data not ready yet
    if (initial.index == null) {
      // Raw-offset target: correct once (Android drops mount contentOffset;
      // iOS this is a no-op-distance scroll).
      initial.settled = true;
      scrollToAbsoluteOffset(initial.offset, false);
      return;
    }
    if (initial.index >= itemCount) return; // data still loading — preserved
    initial.settled = true;
    void scrollToIndexPrecisely({index: initial.index, animated: false});
  }, [range, itemCount, scrollToIndexPrecisely, scrollToAbsoluteOffset]);

  // Recompute sticky after any layoutVersion change — offsets shifting could
  // move the active index even with the same scrollY. Same for viewability:
  // an item growing/shrinking can flip its threshold without any scroll. Also
  // re-runs when paddingTop changes (the active sticky depends on it).
  useEffect(() => {
    const engineOffset = lastScrollOffsetRef.current - effectivePaddingTop;
    // A version bump alone doesn't move the offset — the engine already
    // holds this exact value and would dedupe the call as a no-op; only a
    // real divergence (effectivePaddingTop changed) is worth the crossing.
    if (hybridRef.current && lastPushedEngineOffsetRef.current !== engineOffset) {
      // Under F4, lastScrollOffsetRef is range-cadence fresh — mid-gesture a
      // JS push could rewind the engine behind the worklet's. Push only at
      // rest; while scrolling, the worklet re-pushes a fresher value every
      // frame anyway.
      const activity = scrollActivityRef.current;
      if (!uiThreadDriverActiveRef.current || (!activity.dragging && !activity.momentum)) {
        hybridRef.current.setScrollOffset(engineOffset);
        lastPushedEngineOffsetRef.current = engineOffset;
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
    }
    updateSticky(engineOffset);
    evaluateViewabilityRef.current();
  }, [range.layoutVersion, updateSticky, effectivePaddingTop]);

  // Fire onLoad once after the first non-empty range mounts.
  useEffect(() => {
    if (hasFiredOnLoadRef.current) return;
    if (range.end < range.start) return;
    hasFiredOnLoadRef.current = true;
    onLoad?.();
  }, [range, onLoad]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToOffset({offset, animated = false}: NitroListScrollToOffsetParams) {
        scrollCommandIdRef.current++;
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
        scrollToAbsoluteOffset(offset, animated);
      },
      scrollToIndex({
        index,
        animated = false,
        viewPosition = 0,
        viewOffset = 0,
      }: NitroListScrollToIndexParams) {
        return scrollToIndexPrecisely({index, animated, viewPosition, viewOffset});
      },
      scrollToEnd(animated = false) {
        scrollCommandIdRef.current++;
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
        scrollToAbsoluteOffset(getMaxScrollOffset(), animated);
      },
      getAbsoluteLastScrollOffset() {
        return lastScrollOffsetRef.current;
      },
      getItemOffset(index: number) {
        return readItemOffset(index);
      },
      getItemSize(index: number) {
        return readItemSize(index);
      },
      getTotalSize() {
        return readTotalSize();
      },
      getLayout(index: number) {
        if (index < 0 || index >= itemCount) return undefined;
        const y = readItemOffset(index);
        const height = readItemSize(index);
        return {x: 0, y, width: viewportSizeRef.current.width, height};
      },
      getWindowSize() {
        return {
          width: viewportSizeRef.current.width,
          height: viewportSizeRef.current.height,
        };
      },
      getFirstItemOffset() {
        return effectivePaddingTop;
      },
      getScrollableNode() {
        // With a custom/animated scroll component the instance may not be a
        // plain ScrollView — probe defensively.
        const node = scrollRef.current as
          | (ScrollView & {getScrollableNode?: () => unknown})
          | null;
        return node?.getScrollableNode != null ? node.getScrollableNode() : null;
      },
      getNativeScrollRef() {
        const node = scrollRef.current as
          | (ScrollView & {getNativeScrollRef?: () => unknown})
          | null;
        return node?.getNativeScrollRef != null ? node.getNativeScrollRef() : node;
      },
    }),
    [
      itemCount,
      effectivePaddingTop,
      scrollToAbsoluteOffset,
      scrollToIndexPrecisely,
      getMaxScrollOffset,
      readItemOffset,
      readItemSize,
      readTotalSize,
      cancelFlingPrewarm,
    ],
  );

  // Build engaged children, reading each offset synchronously from native.
  // First render: hybridRef is still null → fallback to estimate. Once the
  // view mounts, native re-emits a range change and we re-read with real values.
  const renderedChildren: React.ReactNode[] = [];
  const renderRanges: RenderRange[] = [];
  pushRenderRange(renderRanges, range, itemCount);
  pushRenderRange(renderRanges, prewarmRange, itemCount);

  for (const {start, end} of mergeRenderRanges(renderRanges)) {
    for (let i = start; i <= end; i++) {
      const item = items[i];
      const itemKey = keyExtractor ? keyExtractor(item, i) : String(i);
      const typeSegment = getItemType ? `${getItemType(item, i)}:` : '';
      const reactKey = `${typeSegment}${itemKey}`;
      const top = readItemOffset(i);
      const isHiddenStickyCell = hideRelatedCell && i === stickyIndexState;
      if (isHiddenStickyCell) {
        // Keep the cell's space (so neighbour offsets stay correct) but render
        // nothing — the floating overlay covers this index.
        const naturalHeight = readItemSize(i);
        renderedChildren.push(<HiddenStickyCell key={reactKey} top={top} height={naturalHeight} />);
      } else {
        renderedChildren.push(
          <NitroListItemContainer
            key={reactKey}
            index={i}
            top={top}
            item={item as unknown}
            renderItem={renderItem as NitroListRenderItem<unknown>}
            SeparatorComponent={
              ItemSeparatorComponent as React.ComponentType<{leadingItem: unknown}> | undefined
            }
            isLastItem={i === itemCount - 1}
            enqueueItemSize={enqueueItemSize}
          />,
        );
      }
    }
  }

  // Yoga ignores the native onMeasure of HybridViews, so we have to declare the
  // total content height explicitly. Re-read from the engine on every render —
  // layoutVersion in `range` triggers a re-render whenever offsets shift.
  const totalSize = readTotalSize();

  const stickyItem =
    stickyIndexState >= 0 && stickyIndexState < itemCount ? items[stickyIndexState] : undefined;

  return (
    <View style={[styles.wrapper, style]}>
      {resolvedRenderScrollComponent({
        ref: scrollRef,
        onScroll: uiThreadDriverActive ? uiThreadScrollHandler : handleOuterScroll,
        onScrollBeginDrag: handleScrollBeginDrag,
        onScrollEndDrag: handleScrollEndDrag,
        onMomentumScrollBegin: handleMomentumScrollBegin,
        onMomentumScrollEnd: handleMomentumScrollEnd,
        onLayout: handleOuterLayout,
        // W4: with events consumed on the UI runtime, 16ms would cap the
        // engine at ~60Hz on 120Hz displays; throttle 1 costs JS nothing
        // there (the JS thread no longer rides scroll events).
        scrollEventThrottle: experimentalUiThreadScroll === true ? 1 : 16,
        contentContainerStyle,
        contentOffset: initialContentOffset,
        children: (
          <>
            {alignPad > 0 ? <View style={{height: alignPad}} /> : null}
            {ListHeaderComponent != null ? (
              <View onLayout={handleHeaderLayout}>{renderSlot(ListHeaderComponent)}</View>
            ) : null}
            {itemCount === 0 ? renderSlot(ListEmptyComponent) : null}
            <NitroListView
              hybridRef={hybridRefCb}
              style={{height: totalSize}}
              itemCount={itemCount}
              estimatedItemSize={estimatedItemSize}
              drawDistance={drawDistance}
              onRangeChange={onRangeChangeCb}>
              {renderedChildren}
            </NitroListView>
            {ListFooterComponent != null ? (
              <View onLayout={handleFooterLayout}>{renderSlot(ListFooterComponent)}</View>
            ) : null}
          </>
        ),
      })}
      {stickyItem !== undefined ? (
        <StickyOverlay translateY={stickyTranslateYSv}>
          {renderItem({item: stickyItem, index: stickyIndexState, target: 'StickyHeader'})}
        </StickyOverlay>
      ) : null}
    </View>
  );
}

interface NitroListItemContainerProps {
  index: number;
  top: number;
  item: unknown;
  renderItem: NitroListRenderItem<unknown>;
  /** Component type (stable reference), not an element — element identity
   *  would break React.memo for every cell on every render. */
  SeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  isLastItem: boolean;
  enqueueItemSize: (index: number, sizeDp: number) => void;
}

function areItemContainerPropsEqual(
  prev: NitroListItemContainerProps,
  next: NitroListItemContainerProps,
): boolean {
  return (
    prev.top === next.top &&
    prev.index === next.index &&
    prev.item === next.item &&
    prev.renderItem === next.renderItem &&
    prev.SeparatorComponent === next.SeparatorComponent &&
    prev.isLastItem === next.isLastItem &&
    prev.enqueueItemSize === next.enqueueItemSize
  );
}

// ≈1 physical pixel in dp. Layout deltas at/below this are native measurement
// jitter (Fabric rounding churn), not real size changes — reporting them costs
// a JSI batch + a layoutVersion bump + a repositioning pass for nothing. The
// native LayoutManager applies the same gate as a second line of defense.
const MEASUREMENT_NOISE_EPSILON_DP = 1 / PixelRatio.get() + 0.01;

const NitroListItemContainer = React.memo(function NitroListItemContainer({
  index,
  top,
  item,
  renderItem,
  SeparatorComponent,
  isLastItem,
  enqueueItemSize,
}: NitroListItemContainerProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemRender();
  }
  // Mount/unmount accounting drives any future recycling decision — the
  // effect body is dev-only; the hook itself must run unconditionally.
  useEffect(() => {
    if (!NITRO_LIST_PERF_COMPILED) return;
    NitroListPerfMonitor.recordItemMount();
    return () => {
      NitroListPerfMonitor.recordItemUnmount();
    };
  }, []);
  const lastReportedRef = useRef<number>(-1);
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const height = e.nativeEvent.layout.height;
      if (
        lastReportedRef.current >= 0 &&
        Math.abs(height - lastReportedRef.current) <= MEASUREMENT_NOISE_EPSILON_DP
      ) {
        return;
      }
      lastReportedRef.current = height;
      // Enqueue into the batched buffer; a RAF drains the queue with a single
      // JSI `setItemSizesBatch` call, so N cells reporting in the same frame
      // produce one native lock + one layoutVersion bump + (on Android) one
      // requestLayout instead of N of each. Per-type size statistics are
      // maintained natively from these same reports.
      enqueueItemSize(index, height);
    },
    [index, enqueueItemSize],
  );
  // Memoize the inline style so only `top` changes break shallow equality on
  // the underlying View. The other absolute positioning props (left/right/
  // position) live on a StyleSheet entry shared across all items.
  const containerStyle = useMemo(() => [styles.absoluteRow, {top}], [top]);
  return (
    <View collapsable={false} onLayout={handleLayout} style={containerStyle}>
      {renderItem({item, index, target: 'Cell'})}
      {SeparatorComponent != null && !isLastItem ? <SeparatorComponent leadingItem={item} /> : null}
    </View>
  );
}, areItemContainerPropsEqual);

interface HiddenStickyCellProps {
  top: number;
  height: number;
}

const HiddenStickyCell = React.memo(function HiddenStickyCell({
  top,
  height,
}: HiddenStickyCellProps) {
  const style = useMemo(() => [styles.absoluteRow, {top, height}], [top, height]);
  return <View collapsable={false} style={style} />;
});

interface StickyOverlayProps {
  /** Owned by the parent: written by the JS sticky driver (default mode) or
   *  by the UI-runtime worklet (F4) — the overlay only consumes it. */
  translateY: SharedValue<number>;
  children: React.ReactNode;
}

// The translation tracks the scroll position so a per-frame setState would
// re-render the entire overlay subtree at scroll cadence. Reanimated keeps
// the transform on the UI thread — zero JS re-renders for ty updates.
const StickyOverlay = React.memo(function StickyOverlay({
  translateY,
  children,
}: StickyOverlayProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateY: translateY.value}],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      collapsable={false}
      style={[styles.stickyOverlay, animatedStyle]}>
      {children}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    overflow: 'hidden',
  },
  stickyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  absoluteRow: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});

export const NitroList = forwardRef(NitroListInner) as <T>(
  props: NitroListProps<T> & {ref?: React.Ref<NitroListHandle>},
) => React.ReactElement | null;
