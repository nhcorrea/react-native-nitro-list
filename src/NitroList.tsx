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
import {computeExecutableMvcpDelta, MVCP_ANCHOR_BASE} from './mvcp';
import {classifyScrollEvent} from './scrollEvents';
import {buildKeyRemapPairs, REMAP_MIN_MAPPED_FRACTION} from './keyRemap';
import {
  createVelocityRing,
  estimateDirectionalVelocity,
  pushVelocitySample,
  resetVelocityRing,
} from './scrollVelocity';
import {
  accumulateEstimateDriftSample,
  checkDuplicateKeyDev,
  maybeWarnJsOnScrollUnderUiDriver,
  maybeWarnMissingKeyExtractor,
  maybeWarnZeroViewport,
  warnDevOnce,
  type EstimateDriftStats,
} from './devWarnings';

export interface NitroListRangeChangeEvent {
  start: number;
  end: number;
  layoutVersion: number;
}

export type NitroListRenderTarget = 'Cell' | 'StickyHeader';

export type NitroListRenderMode = 'normal' | 'fast';

export type NitroListRenderItem<T> = (info: {
  item: T;
  index: number;
  target: NitroListRenderTarget;
  renderMode?: NitroListRenderMode;
}) => React.ReactElement | null;

export type NitroListScrollToOffsetParams = {
  offset: number;
  animated?: boolean;
};

export type NitroListScrollToIndexParams = {
  index: number;
  animated?: boolean;
  viewPosition?: number;
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
  scrollToOffset: (params: NitroListScrollToOffsetParams) => Promise<void>;
  scrollToIndex: (params: NitroListScrollToIndexParams) => Promise<void>;
  scrollToEnd: (animated?: boolean) => Promise<void>;
  getAbsoluteLastScrollOffset: () => number;
  getItemOffset: (index: number) => number;
  getItemSize: (index: number) => number;
  getTotalSize: () => number;
  getLayout: (index: number) => NitroListItemLayout | undefined;
  getWindowSize: () => NitroListWindowSize;
  getFirstItemOffset: () => number;
  getScrollableNode: () => unknown;
  getNativeScrollRef: () => unknown;
  getAverageItemSizes: () => Record<string, {average: number; count: number}>;
  reportContentInset: (insets: {bottom?: number}) => void;
  scrollIndexIntoView: (params: {
    index: number;
    animated?: boolean;
    viewOffset?: number;
  }) => Promise<void>;
  scrollItemIntoView: (params: {item: unknown; animated?: boolean; viewOffset?: number}) => Promise<void>;
};

export type NitroListRenderScrollComponentProps = {
  ref: React.Ref<ScrollView>;
  horizontal?: boolean;
  snapToOffsets?: number[];
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
  contentOffset?: {x: number; y: number};
  maintainVisibleContentPosition?: {minIndexForVisible: number};
  children: React.ReactNode;
};

export type NitroListRenderScrollComponent = (
  props: NitroListRenderScrollComponentProps,
) => React.ReactElement;

export interface NitroListStickyHeaderConfig {
  offset?: number;
  hideRelatedCell?: boolean;
}

export interface NitroListMaintainVisibleContentPositionConfig<T> {
  data?: boolean;
  size?: boolean;
  shouldRestorePosition?: (item: T, index: number) => boolean;
}

export interface NitroListAlwaysRenderConfig {
  top?: number;
  bottom?: number;
  indices?: readonly number[];
  keys?: readonly string[];
}

export interface NitroListAnchoredEndSpaceConfig {
  anchorIndex: number;
  anchorOffset?: number;
  anchorMaxSize?: number;
  onSizeChanged?: (size: number) => void;
  onReady?: () => void;
}

export interface NitroListViewabilityConfig {
  minimumViewTime?: number;
  viewAreaCoveragePercentThreshold?: number;
  itemVisiblePercentThreshold?: number;
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
  estimatedItemSize: number;
  keyExtractor?: (item: T, index: number) => string;
  getItemType?: (item: T, index: number) => string | number;
  getFixedItemSize?: (item: T, index: number, type: string | number | undefined) => number | undefined;
  itemsAreEqual?: (prev: T, next: T, index: number) => boolean;
  dataVersion?: unknown;
  drawDistance?: number;
  horizontal?: boolean;
  numColumns?: number;
  overrideItemLayout?: (layout: {span: number}, item: T, index: number) => void;
  columnWrapperStyle?: {rowGap?: number; columnGap?: number};
  snapToIndices?: readonly number[];
  adaptiveRenderMode?: boolean;
  style?: StyleProp<ViewStyle>;
  renderScrollComponent?: NitroListRenderScrollComponent;
  stickyHeaderIndices?: number[];
  stickyHeaderConfig?: NitroListStickyHeaderConfig;
  onChangeStickyIndex?: (index: number) => void;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollWorklet?: (event: ScrollEvent) => void;
  scrollOffsetSharedValue?: SharedValue<number>;
  onScrollBeginDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLoad?: (info: {elapsedTimeInMs: number}) => void;
  onFirstVisibleItemChanged?: (info: {index: number; item: T; key: string}) => void;
  onItemSizeChanged?: (info: {index: number; size: number}) => void;
  onEndReached?: (info: {distanceFromEnd: number}) => void;
  onEndReachedThreshold?: number;
  onStartReached?: (info: {distanceFromStart: number}) => void;
  onStartReachedThreshold?: number;
  maintainVisibleContentPosition?: boolean | NitroListMaintainVisibleContentPositionConfig<T>;
  experimentalUiThreadScroll?: boolean;
  initialScrollIndex?: number;
  initialScrollOffset?: number;
  initialScrollAtEnd?: boolean;
  alignItemsAtEnd?: boolean;
  maintainScrollAtEnd?: boolean | {threshold?: number; animated?: boolean};
  anchoredEndSpace?: NitroListAnchoredEndSpaceConfig;
  ListHeaderComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  ListFooterComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  ListEmptyComponent?: React.ComponentType<unknown> | React.ReactElement | null;
  ItemSeparatorComponent?: React.ComponentType<{leadingItem: T}> | null;
  viewabilityConfig?: NitroListViewabilityConfig;
  onViewableItemsChanged?: NitroListOnViewableItemsChanged<T>;
  alwaysRender?: NitroListAlwaysRenderConfig;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

const defaultRenderScrollComponent: NitroListRenderScrollComponent = ({
  ref,
  horizontal,
  snapToOffsets,
  onScroll,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollBegin,
  onMomentumScrollEnd,
  onLayout,
  scrollEventThrottle,
  contentContainerStyle,
  contentOffset,
  maintainVisibleContentPosition,
  children,
}) => (
  <ScrollView
    ref={ref}
    horizontal={horizontal}
    snapToOffsets={snapToOffsets}
    style={StyleSheet.absoluteFill}
    contentContainerStyle={contentContainerStyle}
    contentOffset={contentOffset}
    maintainVisibleContentPosition={maintainVisibleContentPosition}
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

const defaultAnimatedRenderScrollComponent: NitroListRenderScrollComponent = ({
  ref,
  horizontal,
  snapToOffsets,
  onScroll,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollBegin,
  onMomentumScrollEnd,
  onLayout,
  scrollEventThrottle,
  contentContainerStyle,
  contentOffset,
  maintainVisibleContentPosition,
  children,
}) => (
  <Animated.ScrollView
    ref={ref as unknown as React.ComponentProps<typeof Animated.ScrollView>['ref']}
    horizontal={horizontal}
    snapToOffsets={snapToOffsets}
    style={StyleSheet.absoluteFill}
    contentContainerStyle={contentContainerStyle}
    contentOffset={contentOffset}
    maintainVisibleContentPosition={maintainVisibleContentPosition}
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
const MVCP_SCROLL_VIEW_CONFIG = Object.freeze({minIndexForVisible: 0});
const INITIAL_DRAW_DISTANCE_DP = 50;
const ZERO_VIEWPORT_WARNING_FRAMES = 10;
const PROGRAMMATIC_ANIMATED_SETTLE_FALLBACK_MS = 700;
const SCROLL_READINESS_TIMEOUT_MS = 800;
const SCROLL_READINESS_STABLE_FRAMES = 2;
const INITIAL_REVEAL_MAX_PASSES = 6;
const INITIAL_REVEAL_STABLE_PASSES = 2;
const INITIAL_REVEAL_TIMEOUT_MS = 1500;
const SCROLL_TO_INDEX_STEPS = 1;
const SCROLL_TO_INDEX_BUFFER_MULTIPLIER = 2;
const SCROLL_TO_INDEX_MAX_RESTARTS = 3;
const SCROLL_TO_INDEX_TARGET_EPSILON = 1;
const SCROLL_TO_INDEX_CORRECTION_PASSES = 3;
const VIEWABILITY_MIN_OFFSET_DELTA = 3;
const UI_VIEWABILITY_MIN_INTERVAL_MS = 32;
const MVCP_POSITION_EPSILON = 0.1;
const FLING_MIN_VELOCITY_DP_S = 1500;
const FLING_TRAVEL_FACTOR = Platform.OS === 'ios' ? 0.4995 : 0.3;
const FLING_MAX_TRAVEL_VIEWPORTS = 4;
const FLING_PREWARM_MAX_ITEMS = 80;
const ADAPTIVE_ENTER_DP_S = 3000;
const ADAPTIVE_EXIT_DP_S = 1000;
const ADAPTIVE_EXIT_DELAY_MS = 250;

type ItemTypeKey = string | number;

type RenderRange = {
  start: number;
  end: number;
};

function readNumericPadding(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractAxisPadding(
  style: StyleProp<ViewStyle>,
  horizontal: boolean,
): {start: number; end: number} {
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  if (!flat) return {start: 0, end: 0};
  const fallback = readNumericPadding(flat.padding);
  if (horizontal) {
    const axis =
      flat.paddingHorizontal != null ? readNumericPadding(flat.paddingHorizontal) : fallback;
    return {
      start: flat.paddingLeft != null ? readNumericPadding(flat.paddingLeft) : axis,
      end: flat.paddingRight != null ? readNumericPadding(flat.paddingRight) : axis,
    };
  }
  const axis = flat.paddingVertical != null ? readNumericPadding(flat.paddingVertical) : fallback;
  return {
    start: flat.paddingStart != null ? readNumericPadding(flat.paddingStart) : axis,
    end: flat.paddingEnd != null ? readNumericPadding(flat.paddingEnd) : axis,
  };
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function waitForLayoutPass(): Promise<void> {
  await waitForNextFrame();
  await waitForNextFrame();
}

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

const EDGE_HYSTERESIS_MULTIPLIER = 1.3;

type EdgeLatchState = {
  isReached: boolean;
  contentSize: number;
  dataLength: number;
};

function checkEdgeThreshold(
  state: EdgeLatchState,
  distance: number,
  thresholdDistance: number,
  contentSize: number,
  dataLength: number,
  allowRearm: boolean,
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
    if (allowRearm) {
      state.isReached = false;
    }
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
  return true;
}

function NitroListInner<T>(props: NitroListProps<T>, ref: React.Ref<NitroListHandle>) {
  const {
    data,
    renderItem,
    estimatedItemSize,
    keyExtractor,
    getItemType,
    getFixedItemSize,
    itemsAreEqual,
    dataVersion,
    horizontal,
    numColumns,
    overrideItemLayout,
    columnWrapperStyle,
    snapToIndices,
    adaptiveRenderMode,
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
    onFirstVisibleItemChanged,
    onItemSizeChanged,
    onEndReached,
    onEndReachedThreshold,
    onStartReached,
    onStartReachedThreshold,
    maintainVisibleContentPosition,
    experimentalUiThreadScroll,
    initialScrollIndex,
    initialScrollOffset,
    initialScrollAtEnd,
    alignItemsAtEnd = false,
    maintainScrollAtEnd,
    anchoredEndSpace,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ItemSeparatorComponent,
    viewabilityConfig,
    onViewableItemsChanged,
    alwaysRender,
    contentContainerStyle,
  } = props;

  const resolvedRenderScrollComponent =
    renderScrollComponent ??
    (experimentalUiThreadScroll === true
      ? defaultAnimatedRenderScrollComponent
      : defaultRenderScrollComponent);

  const items = (data ?? EMPTY) as ReadonlyArray<T>;
  const itemCount = items.length;
  const latestStickyHeaderIndicesRef = useRef(stickyHeaderIndices);
  latestStickyHeaderIndicesRef.current = stickyHeaderIndices;
  const stickyIndicesKey = stickyHeaderIndices != null ? stickyHeaderIndices.join(',') : '';
  const stickyIndices = useMemo<readonly number[]>(() => {
    const latest = latestStickyHeaderIndicesRef.current;
    return latest != null && latest.length > 0 ? latest.slice() : NO_STICKY;
  }, [stickyIndicesKey]);
  const stickyOffset = stickyHeaderConfig?.offset ?? 0;
  const hideRelatedCell = stickyHeaderConfig?.hideRelatedCell ?? false;

  const isHorizontal = horizontal === true;
  const isHorizontalRef = useRef(isHorizontal);
  isHorizontalRef.current = isHorizontal;
  const {start: paddingStart, end: paddingEnd} = useMemo(
    () => extractAxisPadding(contentContainerStyle, isHorizontal),
    [contentContainerStyle, isHorizontal],
  );

  const requestedColumns = Math.max(1, Math.trunc(numColumns ?? 1));
  const resolvedColumns = isHorizontal ? 1 : requestedColumns;
  useEffect(() => {
    if (isHorizontal && requestedColumns > 1) {
      warnDevOnce(
        'columns-with-horizontal',
        'numColumns is ignored with horizontal — the grid lays out rows along the y axis only.',
      );
    }
  }, [isHorizontal, requestedColumns]);
  const mainAxisGap = resolvedColumns > 1 ? (columnWrapperStyle?.rowGap ?? 0) : 0;
  const crossAxisGap = resolvedColumns > 1 ? (columnWrapperStyle?.columnGap ?? 0) : 0;
  const columnsRef = useRef(resolvedColumns);
  columnsRef.current = resolvedColumns;
  const columnLayout = useMemo(() => {
    if (resolvedColumns <= 1 || itemCount === 0) return null;
    const spans = new Uint16Array(itemCount);
    const colOf = new Uint16Array(itemCount);
    const rowStarts = new Int32Array(itemCount);
    const layoutProbe = {span: 1};
    let used = 0;
    let rowStartIdx = 0;
    for (let i = 0; i < itemCount; i++) {
      let span = 1;
      if (overrideItemLayout != null) {
        layoutProbe.span = 1;
        overrideItemLayout(layoutProbe, items[i], i);
        span = Math.max(1, Math.min(resolvedColumns, Math.trunc(layoutProbe.span || 1)));
      }
      if (used > 0 && used + span > resolvedColumns) used = 0;
      if (used === 0) rowStartIdx = i;
      colOf[i] = used;
      spans[i] = span;
      rowStarts[i] = rowStartIdx;
      used += span;
      if (used >= resolvedColumns) used = 0;
    }
    return {spans, colOf, rowStarts};
  }, [resolvedColumns, itemCount, items, overrideItemLayout]);

  const [headerSize, setHeaderSize] = useState(0);
  const [footerSize, setFooterSize] = useState(0);
  const [alignPad, setAlignPad] = useState(0);
  const [endSpace, setEndSpace] = useState(0);
  const endSpaceRef = useRef(0);
  const anchoredEndSpaceRef = useRef(anchoredEndSpace);
  anchoredEndSpaceRef.current = anchoredEndSpace;
  const measuredTailIndicesRef = useRef<Set<number>>(new Set());
  const anchoredReadyRef = useRef<{anchorIndex: number; fired: boolean}>({
    anchorIndex: -1,
    fired: false,
  });
  const updateEndSpaceRef = useRef<() => void>(() => {});

  const effectivePaddingStart = paddingStart + headerSize + alignPad;
  const effectivePaddingStartRef = useRef(effectivePaddingStart);
  effectivePaddingStartRef.current = effectivePaddingStart;

  const initialTargetRef = useRef<{
    offset: number;
    index: number | null;
    settled: boolean;
    endAligned: boolean;
  } | null>(null);
  if (initialTargetRef.current === null) {
    if (initialScrollAtEnd === true) {
      initialTargetRef.current = {
        offset: paddingStart + itemCount * estimatedItemSize,
        index: itemCount > 0 ? itemCount - 1 : null,
        settled: false,
        endAligned: true,
      };
    } else if (initialScrollOffset != null && initialScrollOffset > 0) {
      initialTargetRef.current = {
        offset: initialScrollOffset,
        index: null,
        settled: false,
        endAligned: false,
      };
    } else if (initialScrollIndex != null && initialScrollIndex > 0) {
      initialTargetRef.current = {
        offset: paddingStart + initialScrollIndex * estimatedItemSize,
        index: initialScrollIndex,
        settled: false,
        endAligned: false,
      };
    } else {
      initialTargetRef.current = {offset: 0, index: null, settled: true, endAligned: false};
    }
  }
  const [initialRevealPending, setInitialRevealPending] = useState(
    () => initialTargetRef.current?.settled === false,
  );

  const capInitialDrawRef = useRef<boolean | null>(null);
  if (capInitialDrawRef.current === null) {
    capInitialDrawRef.current = initialTargetRef.current?.settled === true;
  }
  const [drawDistanceExpanded, setDrawDistanceExpanded] = useState(false);
  const effectiveDrawDistance =
    drawDistanceExpanded || !capInitialDrawRef.current
      ? drawDistance
      : Math.min(INITIAL_DRAW_DISTANCE_DP, drawDistance);

  const initialContentOffset = useMemo<{x: number; y: number} | undefined>(() => {
    const initial = initialTargetRef.current;
    if (initial == null || initial.offset <= 0) return undefined;
    return isHorizontal ? {x: initial.offset, y: 0} : {x: 0, y: initial.offset};
  }, [isHorizontal]);

  const scrollRef = useRef<ScrollView>(null);
  const hybridRef = useRef<NitroListViewMethods | null>(null);

  const stickyTranslateYSv = useSharedValue(stickyOffset);
  const uiStickyIndexSv = useSharedValue(-1);
  const lastJsStickyTyRef = useRef<number | null>(null);

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

  const mvcpConfigObject =
    typeof maintainVisibleContentPosition === 'object' && maintainVisibleContentPosition != null
      ? maintainVisibleContentPosition
      : null;
  const mvcpSizeEnabled =
    maintainVisibleContentPosition === false
      ? false
      : mvcpConfigObject != null
        ? (mvcpConfigObject.size ?? true)
        : true;
  const mvcpDataEnabled =
    maintainVisibleContentPosition === true
      ? true
      : mvcpConfigObject != null
        ? (mvcpConfigObject.data ?? false)
        : false;
  const mvcpEnabled = mvcpSizeEnabled || mvcpDataEnabled;
  const mvcpResolvedRef = useRef({size: mvcpSizeEnabled, data: mvcpDataEnabled});
  mvcpResolvedRef.current = {size: mvcpSizeEnabled, data: mvcpDataEnabled};
  const mvcpShouldRestoreRef = useRef<((item: T, index: number) => boolean) | null>(null);
  mvcpShouldRestoreRef.current = mvcpConfigObject?.shouldRestorePosition ?? null;
  const mvcpStateRef = useRef<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>({enabled: false, anchor: null});
  mvcpStateRef.current.enabled = mvcpEnabled;
  if (!mvcpStateRef.current.enabled) {
    mvcpStateRef.current.anchor = null;
  }
  const [mvcpAdjust, setMvcpAdjust] = useState(0);
  const applyMvcpCorrectionRef = useRef<(diff: number) => void>(() => {});
  const latestRangeRef = useRef<{start: number; end: number}>({start: 0, end: -1});
  const isPrewarmingRangeRef = useRef(false);
  const scrollActivityRef = useRef<{
    dragging: boolean;
    momentum: boolean;
    programmaticAnimated: boolean;
    pendingAdjust: number;
  }>({dragging: false, momentum: false, programmaticAnimated: false, pendingAdjust: 0});
  const programmaticAnimatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animatedScrollResolverRef = useRef<(() => void) | null>(null);
  const resolveAnimatedScrollCommand = useCallback(() => {
    const resolver = animatedScrollResolverRef.current;
    if (resolver != null) {
      animatedScrollResolverRef.current = null;
      resolver();
    }
  }, []);
  const endProgrammaticAnimatedScroll = useCallback(() => {
    if (programmaticAnimatedTimerRef.current != null) {
      clearTimeout(programmaticAnimatedTimerRef.current);
      programmaticAnimatedTimerRef.current = null;
    }
    scrollActivityRef.current.programmaticAnimated = false;
    resolveAnimatedScrollCommand();
  }, [resolveAnimatedScrollCommand]);
  useEffect(() => endProgrammaticAnimatedScroll, [endProgrammaticAnimatedScroll]);
  const scrollVelocityRef = useRef<{offset: number; time: number; velocity: number}>({
    offset: 0,
    time: 0,
    velocity: 0,
  });
  const velocityRingRef = useRef(createVelocityRing());
  const [renderMode, setRenderMode] = useState<NitroListRenderMode>('normal');
  const adaptiveEnabledRef = useRef(adaptiveRenderMode === true);
  adaptiveEnabledRef.current = adaptiveRenderMode === true;
  const adaptiveStateRef = useRef<{
    mode: NitroListRenderMode;
    timer: ReturnType<typeof setTimeout> | null;
  }>({mode: 'normal', timer: null});
  const noteVelocityForAdaptive = useCallback((velocityDpS: number) => {
    if (!adaptiveEnabledRef.current) return;
    const speed = Math.abs(velocityDpS);
    const state = adaptiveStateRef.current;
    if (speed >= ADAPTIVE_ENTER_DP_S) {
      if (state.timer != null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.mode !== 'fast') {
        state.mode = 'fast';
        setRenderMode('fast');
      }
    } else if (speed <= ADAPTIVE_EXIT_DP_S && state.mode === 'fast' && state.timer == null) {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.mode = 'normal';
        setRenderMode('normal');
      }, ADAPTIVE_EXIT_DELAY_MS);
    }
  }, []);
  useEffect(
    () => () => {
      if (adaptiveStateRef.current.timer != null) {
        clearTimeout(adaptiveStateRef.current.timer);
      }
    },
    [],
  );
  const suppressEdgeRearmRef = useRef(false);
  const prewarmFlingDestinationRef = useRef<() => void>(() => {});
  const recordFlingOutcomeRef = useRef<(finalAbsoluteY: number) => void>(() => {});
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

  const pendingSizesRef = useRef<{
    buffer: Float64Array;
    count: number;
    rafId: number | null;
  }>({buffer: new Float64Array(32 * 2), count: 0, rafId: null});

  const measurementCtxRef = useRef<{
    items: ReadonlyArray<T>;
    getItemType?: (item: T, index: number) => ItemTypeKey;
    estimatedItemSize: number;
  }>({items, getItemType, estimatedItemSize});
  useEffect(() => {
    measurementCtxRef.current = {items, getItemType, estimatedItemSize};
  });
  const estimateDriftStatsRef = useRef<Map<string, EstimateDriftStats> | null>(null);
  const onItemSizeChangedRef = useRef(onItemSizeChanged);
  useEffect(() => {
    onItemSizeChangedRef.current = onItemSizeChanged;
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
        return;
      }
      const tight = new Float64Array(pairCount * 2);
      tight.set(state.buffer.subarray(0, pairCount * 2));
      state.count = 0;
      if (NITRO_LIST_PERF_COMPILED) {
        NitroListPerfMonitor.recordBatchFlush(pairCount);
        NitroListPerfMonitor.recordJsiCall();
      }
      const mvcp = mvcpStateRef.current;
      const anchor =
        mvcp.enabled && mvcpResolvedRef.current.size && !isPrewarmingRangeRef.current
          ? mvcp.anchor
          : null;
      if (anchor != null) {
        const diff = hybrid.setItemSizesBatchAnchored(tight.buffer, anchor.index, emitRange);
        invalidateLayoutCache();
        if (Math.abs(diff) > MVCP_POSITION_EPSILON) {
          applyMvcpCorrectionRef.current(diff);
        }
      } else {
        hybrid.setItemSizesBatch(tight.buffer, emitRange);
        invalidateLayoutCache();
        const staleAnchor = mvcp.enabled ? mvcp.anchor : null;
        if (staleAnchor != null) {
          staleAnchor.offset = readItemOffset(staleAnchor.index);
        }
      }
      const sizeChanged = onItemSizeChangedRef.current;
      if (sizeChanged != null) {
        for (let k = 0; k < pairCount; k++) {
          sizeChanged({index: tight[k * 2] | 0, size: tight[k * 2 + 1]});
        }
      }
      if (anchoredEndSpaceRef.current != null) {
        updateEndSpaceRef.current();
      }
      const ctx = measurementCtxRef.current;
      const widthDp = crossViewportRef.current / columnsRef.current;
      const recordToCache = ctx.getItemType != null && widthDp > 0;
      if (recordToCache || IS_DEV) {
        const fontScale = recordToCache ? PixelRatio.getFontScale() : 1;
        let driftStats = estimateDriftStatsRef.current;
        if (IS_DEV && driftStats == null) {
          driftStats = new Map();
          estimateDriftStatsRef.current = driftStats;
        }
        for (let k = 0; k < pairCount; k++) {
          const idx = tight[k * 2] | 0;
          const item = ctx.items[idx];
          if (item === undefined) continue;
          const type = ctx.getItemType?.(item, idx);
          if (recordToCache) {
            recordMeasurement(
              measurementCacheKey(type as ItemTypeKey, widthDp, fontScale),
              tight[k * 2 + 1],
            );
          }
          if (driftStats != null) {
            accumulateEstimateDriftSample(
              driftStats,
              type != null ? String(type) : '',
              tight[k * 2 + 1],
              ctx.estimatedItemSize,
            );
          }
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
      measuredTailIndicesRef.current.add(index);
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(() => {
          flushPendingItemSizes();
        });
      }
    },
    [flushPendingItemSizes],
  );

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

  const pushFixedItemSizes = useCallback(() => {
    if (getFixedItemSize == null || itemCount === 0 || hybridRef.current == null) return;
    for (let i = 0; i < itemCount; i++) {
      const item = items[i];
      const size = getFixedItemSize(item, i, getItemType?.(item, i));
      if (size != null && Number.isFinite(size) && size >= 0) {
        enqueueItemSize(i, size);
      }
    }
    flushPendingItemSizes();
  }, [getFixedItemSize, getItemType, items, itemCount, enqueueItemSize, flushPendingItemSizes]);
  const pushFixedItemSizesRef = useRef(pushFixedItemSizes);
  pushFixedItemSizesRef.current = pushFixedItemSizes;

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

  const lastScrollOffsetRef = useRef(initialTargetRef.current?.offset ?? 0);
  const viewportSizeRef = useRef<{width: number; height: number}>({width: 0, height: 0});
  const mainViewportRef = useRef(0);
  const crossViewportRef = useRef(0);
  const hasFiredOnLoadRef = useRef(false);
  const mountTimestampRef = useRef(Date.now());
  const stickyIndexRef = useRef(-1);

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
  const stickToEndRef = useRef<{
    wasAtEnd: boolean;
    lastContent: number;
    pending: boolean;
    regrow: boolean;
  }>({
    wasAtEnd: false,
    lastContent: 0,
    pending: false,
    regrow: false,
  });
  const scrollToEndForMaintainRef = useRef<(animated: boolean) => void | Promise<void>>(() => {});
  const updateAlignPadRef = useRef<() => void>(() => {});
  const cancelPendingStickToEnd = useCallback(() => {
    const stick = stickToEndRef.current;
    stick.wasAtEnd = false;
    stick.pending = false;
    stick.regrow = false;
  }, []);
  const scheduleStickToEnd = useCallback((animated: boolean) => {
    const stick = stickToEndRef.current;
    stick.pending = true;
    requestAnimationFrame(() => {
      const current = stickToEndRef.current;
      const activity = scrollActivityRef.current;
      if (!current.wasAtEnd || activity.dragging || activity.momentum) {
        current.pending = false;
        current.regrow = false;
        return;
      }
      Promise.resolve(scrollToEndForMaintainRef.current(animated)).then(() => {
        const settled = stickToEndRef.current;
        settled.pending = false;
        if (settled.regrow) {
          settled.regrow = false;
          if (settled.wasAtEnd) {
            scheduleStickToEnd(animated);
          }
        }
      });
    });
  }, []);

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;

  const checkEdgeCallbacks = useCallback(() => {
    const allowRearm = !suppressEdgeRearmRef.current;
    suppressEdgeRearmRef.current = false;
    const maintain = anchoredEndSpaceRef.current == null ? maintainAtEndRef.current : null;
    if (!onEndReached && !onStartReached && maintain == null) return;
    const liveItemCount = itemCountRef.current;
    const viewportH = mainViewportRef.current;
    if (viewportH <= 0 || liveItemCount === 0) return;
    const totalContent =
      effectivePaddingStartRef.current +
      readTotalSize() +
      footerSize +
      paddingEnd +
      endSpaceRef.current;
    const scrollY = lastScrollOffsetRef.current;
    if (maintain != null) {
      const stick = stickToEndRef.current;
      const contentGrew = totalContent > stick.lastContent + 1;
      if (!contentGrew) {
        if (!stick.pending) {
          stick.wasAtEnd =
            totalContent - scrollY - viewportH <= maintain.threshold * viewportH ||
            totalContent <= viewportH;
        }
      } else if (stick.pending) {
        stick.regrow = true;
      } else if (stick.wasAtEnd) {
        const activity = scrollActivityRef.current;
        if (!activity.dragging && !activity.momentum) {
          scheduleStickToEnd(maintain.animated);
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
        liveItemCount,
        allowRearm,
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
        liveItemCount,
        allowRearm,
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
    paddingEnd,
    readTotalSize,
    scheduleStickToEnd,
  ]);

  const checkEdgeCallbacksRef = useRef(checkEdgeCallbacks);
  useEffect(() => {
    checkEdgeCallbacksRef.current = checkEdgeCallbacks;
    checkEdgeCallbacks();
  }, [checkEdgeCallbacks]);

  const viewableMapRef = useRef<Map<number, NitroListViewToken<T>>>(new Map());
  const pendingMapRef = useRef<Map<number, number>>(new Map());
  const viewabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasInteractedRef = useRef(false);
  const evaluateViewabilityRef = useRef<() => void>(() => {});
  const lastViewabilityEvalRef = useRef<{
    offset: number;
    start: number;
    end: number;
    layoutVersion: number;
  }>({offset: Number.NaN, start: -1, end: -2, layoutVersion: -1});
  const typeIdMapRef = useRef<Map<ItemTypeKey, number>>(new Map());
  const lastSentTypesRef = useRef<Uint16Array | null>(null);

  const seedTypeMeansFromCache = useCallback(() => {
    const hybrid = hybridRef.current;
    if (!hybrid) return;
    const map = typeIdMapRef.current;
    const widthDp = crossViewportRef.current / columnsRef.current;
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
    hybrid.seedTypeMeans(seeds.slice(0, seedCount * 2).buffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
  }, []);
  const slabRef = useRef<Float64Array<ArrayBuffer>>(new Float64Array(4 + 2 * 64));
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
  const pendingScrollResolversRef = useRef<Map<number, () => void>>(new Map());
  const resolveScrollCommand = useCallback((commandId: number) => {
    const resolver = pendingScrollResolversRef.current.get(commandId);
    if (resolver != null) {
      pendingScrollResolversRef.current.delete(commandId);
      resolver();
    }
  }, []);
  const beginScrollCommand = useCallback(() => {
    const pending = pendingScrollResolversRef.current;
    if (pending.size > 0) {
      const resolvers = Array.from(pending.values());
      pending.clear();
      for (const resolve of resolvers) resolve();
    }
    return ++scrollCommandIdRef.current;
  }, []);
  const trackScrollCommand = useCallback((commandId: number) => {
    return new Promise<void>((resolve) => {
      if (commandId !== scrollCommandIdRef.current) {
        resolve();
        return;
      }
      pendingScrollResolversRef.current.set(commandId, resolve);
    });
  }, []);
  useEffect(
    () => () => {
      const pending = pendingScrollResolversRef.current;
      const resolvers = Array.from(pending.values());
      pending.clear();
      for (const resolve of resolvers) resolve();
    },
    [],
  );
  const dataJustChangedRef = useRef(false);
  const awaitScrollReadiness = useCallback(async (commandId: number) => {
    if (!dataJustChangedRef.current) return;
    dataJustChangedRef.current = false;
    const deadline = Date.now() + SCROLL_READINESS_TIMEOUT_MS;
    let stableFrames = 0;
    let lastVersion = lastSeenLayoutVersionRef.current;
    while (stableFrames < SCROLL_READINESS_STABLE_FRAMES && Date.now() < deadline) {
      await waitForNextFrame();
      if (commandId !== scrollCommandIdRef.current) return;
      const version = lastSeenLayoutVersionRef.current;
      if (version === lastVersion) {
        stableFrames++;
      } else {
        stableFrames = 0;
        lastVersion = version;
      }
    }
  }, []);
  const estimateFreezeDepthRef = useRef(0);
  const acquireEstimateFreeze = useCallback(() => {
    if (++estimateFreezeDepthRef.current === 1 && hybridRef.current) {
      hybridRef.current.setEstimatesFrozen(true);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    }
  }, []);
  const releaseEstimateFreeze = useCallback(() => {
    if (
      estimateFreezeDepthRef.current > 0 &&
      --estimateFreezeDepthRef.current === 0 &&
      hybridRef.current
    ) {
      hybridRef.current.setEstimatesFrozen(false);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    }
  }, []);
  const lastPrewarmRangeRef = useRef<{
    start: number;
    end: number;
    layoutVersion: number;
  } | null>(null);

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
    seedTypeMeansFromCache();
  }, [getItemType, itemCount, items, seedTypeMeansFromCache]);

  const pushItemTypesRef = useRef(pushItemTypes);
  useEffect(() => {
    pushItemTypesRef.current = pushItemTypes;
    pushItemTypes();
  }, [pushItemTypes]);

  const lastSentSpansRef = useRef<Uint16Array | null>(null);
  const pushItemSpans = useCallback(() => {
    const hybrid = hybridRef.current;
    if (!hybrid) return;
    const spans = columnLayout != null ? columnLayout.spans : new Uint16Array(0);
    const last = lastSentSpansRef.current;
    if (last != null && last.length === spans.length) {
      let equal = true;
      for (let i = 0; i < spans.length; i++) {
        if (last[i] !== spans[i]) {
          equal = false;
          break;
        }
      }
      if (equal) return;
    }
    if (last == null && spans.length === 0) {
      lastSentSpansRef.current = spans;
      return;
    }
    lastSentSpansRef.current = spans;
    hybrid.setItemSpans(spans.buffer as ArrayBuffer);
    if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
  }, [columnLayout]);
  const pushItemSpansRef = useRef(pushItemSpans);
  useEffect(() => {
    pushItemSpansRef.current = pushItemSpans;
    pushItemSpans();
  }, [pushItemSpans]);

  const handleHybridRef = useCallback(
    (value: NitroListViewMethods | null) => {
      hybridRef.current = value;
      setAttachedHybrid(value);
      invalidateLayoutCache();
      if (!value) return;
      const {width, height} = viewportSizeRef.current;
      if (width > 0 || height > 0) {
        value.setViewport(width, height);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
      const replayEngineOffset = lastScrollOffsetRef.current - effectivePaddingStartRef.current;
      value.setScrollOffset(replayEngineOffset);
      lastPushedEngineOffsetRef.current = replayEngineOffset;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      lastSentTypesRef.current = null;
      pushItemTypesRef.current();
      lastSentSpansRef.current = null;
      pushItemSpansRef.current();
      if (estimateFreezeDepthRef.current > 0) {
        value.setEstimatesFrozen(true);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
      pushFixedItemSizesRef.current();
      flushPendingItemSizes();
      evaluateViewabilityRef.current();
    },
    [invalidateLayoutCache, flushPendingItemSizes],
  );
  const hybridRefCb = useMemo(() => callback(handleHybridRef), [handleHybridRef]);

  const [attachedHybrid, setAttachedHybrid] = useState<NitroListViewMethods | null>(null);
  const uiThreadDriverActive =
    experimentalUiThreadScroll === true && attachedHybrid != null;
  const uiThreadDriverActiveRef = useRef(uiThreadDriverActive);
  uiThreadDriverActiveRef.current = uiThreadDriverActive;

  const uiPaddingTopSv = useSharedValue(0);
  useEffect(() => {
    uiPaddingTopSv.value = effectivePaddingStart;
  }, [effectivePaddingStart, uiPaddingTopSv]);
  const uiScrollOffsetSv = useSharedValue(
    (initialTargetRef.current?.offset ?? 0) - paddingStart,
  );
  useEffect(() => {
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

  const [stickyIndexState, setStickyIndexState] = useState(-1);

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
        slabRef.current = new Float64Array(slab.length * 2);
        slab = slabRef.current;
        written = hybrid.fillLayoutSlab(slab.buffer);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        if (written < 0) return;
      }
      writeSlabToCache(slab, written);
    },
    [writeSlabToCache],
  );

  const lastSeenLayoutVersionRef = useRef<number>(-1);
  const captureMvcpAnchorRef = useRef<(engineOffset: number) => void>(() => {});
  const emitFirstVisibleRef = useRef<() => void>(() => {});
  const lastFirstVisibleIndexRef = useRef(-1);
  const onFirstVisibleItemChangedRef = useRef(onFirstVisibleItemChanged);
  useEffect(() => {
    onFirstVisibleItemChangedRef.current = onFirstVisibleItemChanged;
  });
  const handleRangeChange = useCallback(
    (start: number, end: number, layoutVersion: number, engineOffset: number) => {
      const event: NitroListRangeChangeEvent = {start, end, layoutVersion};
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        NitroListPerfMonitor.recordRangeEvent();
        if (event.end >= event.start) {
          NitroListPerfMonitor.recordFirstRange(mountTimestampRef.current);
        }
      }
      const uiDriven = uiThreadDriverActiveRef.current && !isPrewarmingRangeRef.current;
      let offsetConsumed = false;
      if (uiDriven) {
        lastScrollOffsetRef.current = engineOffset + effectivePaddingStartRef.current;
        offsetConsumed = true;
      }
      if (event.layoutVersion !== lastSeenLayoutVersionRef.current) {
        lastSeenLayoutVersionRef.current = event.layoutVersion;
        invalidateLayoutCache();
        checkEdgeCallbacksRef.current();
      }
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
        evaluateViewabilityRef.current();
        checkEdgeCallbacksRef.current();
        captureMvcpAnchorRef.current(engineOffset);
        emitFirstVisibleRef.current();
        if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
          const viewportH = mainViewportRef.current;
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

  const lastPushedEngineOffsetRef = useRef<number | null>(null);

  const applyScrollOffsetSync = useCallback(
    (engineOffset: number) => {
      const hybrid = hybridRef.current;
      if (!hybrid) return;
      let slab = slabRef.current;
      let written = hybrid.setScrollOffsetAndFill(engineOffset, slab.buffer);
      lastPushedEngineOffsetRef.current = engineOffset;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      if (written < 0) {
        slabRef.current = new Float64Array(slab.length * 2);
        slab = slabRef.current;
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
        uiStickyIndexSv.value = -1;
        applyStickyIndex(-1);
        return;
      }
      if (uiThreadDriverActiveRef.current) {
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
      if (viewable.size > 0) viewable.clear();
      if (pending.size > 0) pending.clear();
      return;
    }
    const hybrid = hybridRef.current;
    const viewportH = mainViewportRef.current;
    const offset = lastScrollOffsetRef.current - effectivePaddingStartRef.current;
    if (!hybrid || viewportH <= 0) return;

    const minimumViewTime = config.minimumViewTime ?? 0;
    const waitForInteraction = config.waitForInteraction ?? false;

    const start = Math.max(0, range.start);
    const end = Math.min(range.end, items.length - 1);

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

    const pendingKeys = scratch.pendingKeysSnapshot;
    pendingKeys.length = 0;
    for (const idx of pending.keys()) pendingKeys.push(idx);
    for (let i = 0; i < pendingKeys.length; i++) {
      const idx = pendingKeys[i];
      if (!potential.has(idx)) pending.delete(idx);
    }

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
      dataJustChangedRef.current = true;
      const prevItems = previousItemsRef.current;
      previousItemsRef.current = items;
      previousDataVersionRef.current = dataVersion;
      const keysChanged = keyExtractor
        ? didKeysChangeStructurally(prevItems, items, keyExtractor)
        : true;
      if (versionChanged || keysChanged) {
        if (!versionChanged) {
          maybeWarnMissingKeyExtractor(keyExtractor != null, prevItems.length, items.length);
        }
        const mvcpAnchorBefore =
          mvcpStateRef.current.enabled && mvcpResolvedRef.current.data && keyExtractor != null
            ? mvcpStateRef.current.anchor
            : null;
        if (hybridRef.current != null && (versionChanged || keyExtractor)) {
          let remapped = false;
          if (!versionChanged && keyExtractor != null && items.length > 0) {
            const remap = buildKeyRemapPairs(prevItems, items, keyExtractor);
            if (remap != null && remap.mappedCount >= items.length * REMAP_MIN_MAPPED_FRACTION) {
              hybridRef.current.remapItemSizes(remap.pairs.buffer as ArrayBuffer);
              const translatedTail = new Set<number>();
              const previousTail = measuredTailIndicesRef.current;
              for (let p = 0; p < remap.pairs.length; p += 2) {
                if (previousTail.has(remap.pairs[p])) translatedTail.add(remap.pairs[p + 1]);
              }
              measuredTailIndicesRef.current = translatedTail;
              remapped = true;
            }
          }
          if (!remapped) {
            hybridRef.current.resetItemSizes();
            measuredTailIndicesRef.current = new Set();
          }
          if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        }
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
            mvcpStateRef.current.anchor = null;
          }
        }
        viewableMapRef.current = new Map();
        pendingMapRef.current = new Map();
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
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
        const viewable = viewableMapRef.current;
        for (const [idx, tok] of viewable) {
          const item = items[idx];
          if (item !== undefined && tok.item !== item) {
            viewable.set(idx, {...tok, item});
          }
        }
      }
    }
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

  useEffect(() => {
    pushFixedItemSizes();
  }, [pushFixedItemSizes]);

  useEffect(() => {
    if (!IS_DEV || itemCount === 0) return;
    let cancelled = false;
    let framesLeft = ZERO_VIEWPORT_WARNING_FRAMES;
    let rafId = 0;
    const tick = () => {
      if (cancelled) return;
      if (mainViewportRef.current > 0) return;
      if (--framesLeft <= 0) {
        maybeWarnZeroViewport(mainViewportRef.current, itemCount);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [itemCount]);

  useEffect(() => {
    maybeWarnJsOnScrollUnderUiDriver(userOnScroll != null, experimentalUiThreadScroll === true);
  }, [userOnScroll, experimentalUiThreadScroll]);

  useEffect(() => {
    if (mvcpEnabled && renderScrollComponent != null) {
      warnDevOnce(
        'mvcp-custom-scroll-component',
        'maintainVisibleContentPosition with a custom renderScrollComponent: forward the ' +
          '`maintainVisibleContentPosition` prop to your ScrollView (and keep ' +
          '`removeClippedSubviews` off), otherwise position corrections will not be applied.',
      );
    }
  }, [mvcpEnabled, renderScrollComponent]);

  useEffect(
    () => () => {
      if (viewabilityTimerRef.current != null) {
        clearTimeout(viewabilityTimerRef.current);
        viewabilityTimerRef.current = null;
      }
    },
    [],
  );

  const captureMvcpAnchor = useCallback(
    (engineOffset: number) => {
      const mvcp = mvcpStateRef.current;
      if (!mvcp.enabled) return;
      const shouldRestore = mvcpShouldRestoreRef.current;
      const isEligible = (index: number) => {
        if (shouldRestore == null) return true;
        const candidate = items[index];
        return candidate === undefined || shouldRestore(candidate, index) !== false;
      };
      const r = latestRangeRef.current;
      let anchorIndex = -1;
      for (let i = Math.max(0, r.start); i <= r.end; i++) {
        if (readItemOffset(i) >= engineOffset && isEligible(i)) {
          anchorIndex = i;
          break;
        }
      }
      if (anchorIndex < 0) {
        for (let i = r.end; i >= Math.max(0, r.start); i--) {
          if (isEligible(i)) {
            anchorIndex = i;
            break;
          }
        }
      }
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
      } else {
        mvcp.anchor = null;
      }
    },
    [items, keyExtractor, readItemOffset],
  );
  useEffect(() => {
    captureMvcpAnchorRef.current = captureMvcpAnchor;
  }, [captureMvcpAnchor]);

  const handleOuterScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const scrollY = isHorizontalRef.current
        ? e.nativeEvent.contentOffset.x
        : e.nativeEvent.contentOffset.y;
      if (!uiThreadDriverActiveRef.current && pendingSizesRef.current.count > 0) {
        flushPendingItemSizes(false);
      }
      const kind = classifyScrollEvent(
        scrollY,
        lastScrollOffsetRef.current,
        mainViewportRef.current,
        scrollActivityRef.current.programmaticAnimated,
      );
      if (isPrewarmingRangeRef.current) {
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        setPrewarmRange(null);
      }
      const velocitySample = scrollVelocityRef.current;
      const nowMs = Date.now();
      if (kind === 'large-jump') {
        velocitySample.velocity = 0;
        resetVelocityRing(velocityRingRef.current);
        cancelFlingPrewarm();
        suppressEdgeRearmRef.current = true;
      } else {
        const dtMs = nowMs - velocitySample.time;
        if (dtMs > 200) {
          velocitySample.velocity = 0;
        } else if (dtMs >= 1) {
          velocitySample.velocity = ((scrollY - velocitySample.offset) / dtMs) * 1000;
        }
        pushVelocitySample(velocityRingRef.current, scrollY, nowMs);
      }
      velocitySample.offset = scrollY;
      velocitySample.time = nowMs;
      noteVelocityForAdaptive(velocitySample.velocity);
      lastScrollOffsetRef.current = scrollY;
      if (scrollOffsetSharedValue != null) {
        scrollOffsetSharedValue.value = scrollY;
      }
      const engineOffset = scrollY - effectivePaddingStartRef.current;
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        NitroListPerfMonitor.markScrollDispatch();
      }
      if (uiThreadDriverActiveRef.current) {
      } else {
        applyScrollOffsetSync(engineOffset);
      }
      updateSticky(engineOffset);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      captureMvcpAnchor(engineOffset);
      emitFirstVisibleRef.current();
      if (NITRO_LIST_PERF_COMPILED && NitroListPerfMonitor.enabled) {
        const viewportH = mainViewportRef.current;
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
      cancelFlingPrewarm,
      noteVelocityForAdaptive,
    ],
  );

  const handleOuterLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const {width, height} = e.nativeEvent.layout;
      viewportSizeRef.current = {width, height};
      mainViewportRef.current = isHorizontalRef.current ? width : height;
      crossViewportRef.current = isHorizontalRef.current ? height : width;
      hybridRef.current?.setViewport(width, height);
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      seedTypeMeansFromCache();
      updateAlignPadRef.current();
      updateEndSpaceRef.current();
      updateSticky(lastScrollOffsetRef.current - effectivePaddingStartRef.current);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      emitFirstVisibleRef.current();
    },
    [updateSticky, seedTypeMeansFromCache],
  );

  const flushPendingMvcpAdjust = useCallback(() => {
    const activity = scrollActivityRef.current;
    const pending = activity.pendingAdjust;
    if (pending === 0) return;
    activity.pendingAdjust = 0;
    if (Math.abs(pending) > MVCP_POSITION_EPSILON) {
      const anchor = mvcpStateRef.current.anchor;
      if (anchor != null) anchor.offset -= pending;
      applyMvcpCorrectionRef.current(pending);
    }
  }, []);

  const handleScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      endProgrammaticAnimatedScroll();
      flushPendingMvcpAdjust();
      beginScrollCommand();
      cancelPendingStickToEnd();
      const activity = scrollActivityRef.current;
      activity.dragging = true;
      activity.momentum = false;
      cancelFlingPrewarm();
      if (uiThreadDriverActiveRef.current && isPrewarmingRangeRef.current) {
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
      }
      if (!isPrewarmingRangeRef.current) {
        setPrewarmRange(null);
      }
      if (!hasInteractedRef.current) {
        hasInteractedRef.current = true;
        lastViewabilityEvalRef.current.offset = Number.NaN;
        evaluateViewabilityRef.current();
      }
      onScrollBeginDrag?.(e);
    },
    [
      onScrollBeginDrag,
      flushPendingMvcpAdjust,
      cancelFlingPrewarm,
      endProgrammaticAnimatedScroll,
      beginScrollCommand,
      cancelPendingStickToEnd,
    ],
  );
  const handleScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const activity = scrollActivityRef.current;
      activity.dragging = false;
      if (uiThreadDriverActiveRef.current) {
        lastScrollOffsetRef.current = isHorizontalRef.current
          ? e.nativeEvent.contentOffset.x
          : e.nativeEvent.contentOffset.y;
      } else {
        const launchVelocity = estimateDirectionalVelocity(velocityRingRef.current, Date.now());
        scrollVelocityRef.current.velocity = launchVelocity;
        if (Math.abs(launchVelocity) >= FLING_MIN_VELOCITY_DP_S) {
          prewarmFlingDestinationRef.current();
        } else {
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
      endProgrammaticAnimatedScroll();
      noteVelocityForAdaptive(0);
      const momentumOffset = isHorizontalRef.current
        ? e.nativeEvent.contentOffset.x
        : e.nativeEvent.contentOffset.y;
      recordFlingOutcomeRef.current(momentumOffset);
      cancelFlingPrewarm();
      if (!isPrewarmingRangeRef.current) {
        setPrewarmRange(null);
      }
      const uiDriven = uiThreadDriverActiveRef.current;
      if (uiDriven) {
        lastScrollOffsetRef.current = momentumOffset;
      }
      flushPendingMvcpAdjust();
      if (uiDriven) {
        const engineOffset = lastScrollOffsetRef.current - effectivePaddingStartRef.current;
        evaluateViewabilityRef.current();
        checkEdgeCallbacksRef.current();
        captureMvcpAnchor(engineOffset);
        emitFirstVisibleRef.current();
      }
      onMomentumScrollEnd?.(e);
    },
    [
      onMomentumScrollEnd,
      flushPendingMvcpAdjust,
      cancelFlingPrewarm,
      captureMvcpAnchor,
      endProgrammaticAnimatedScroll,
      noteVelocityForAdaptive,
    ],
  );


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
        prewarmFlingDestinationRef.current();
      } else {
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
    const contentOffset = isHorizontalRef.current ? {x: y, y: 0} : {x: 0, y};
    userOnScrollRef.current?.({
      nativeEvent: {contentOffset},
    } as NativeSyntheticEvent<NativeScrollEvent>);
  }, []);

  const hasUserOnScroll = userOnScroll != null;
  const hasViewabilityWakeups = onViewableItemsChanged != null && viewabilityConfig != null;
  const stickyCount = stickyIndices.length;

  const uiThreadScrollHandler = useAnimatedScrollHandler<UiScrollContext>(
    {
      onScroll: (event, ctx) => {
        'worklet';
        const y = isHorizontal ? event.contentOffset.x : event.contentOffset.y;
        const engineOffset = y - uiPaddingTopSv.value;
        if (attachedHybrid != null) {
          attachedHybrid.setScrollOffset(engineOffset);
        }
        uiScrollOffsetSv.value = engineOffset;
        if (scrollOffsetSharedValue != null) {
          scrollOffsetSharedValue.value = y;
        }
        const now = Date.now();
        const lastTime = ctx.lastTime;
        const lastY = ctx.lastY;
        if (lastTime == null || lastY == null || now - lastTime > 200) {
          ctx.velocity = 0;
        } else if (now - lastTime >= 1) {
          ctx.velocity = ((y - lastY) / (now - lastTime)) * 1000;
        }
        ctx.lastY = y;
        ctx.lastTime = now;
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
          scheduleOnRN(emitUserScrollFromUi, y);
        }
      },
      onEndDrag: (event, ctx) => {
        'worklet';
        scheduleOnRN(
          settleUiEndDrag,
          ctx.velocity ?? 0,
          isHorizontal ? event.contentOffset.x : event.contentOffset.y,
        );
      },
    },
    [
      attachedHybrid,
      isHorizontal,
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

  const contentInsetBottomRef = useRef(0);

  const getMaxScrollOffset = useCallback(() => {
    const totalSize = readTotalSize();
    const viewportH = mainViewportRef.current;
    const totalContent =
      effectivePaddingStartRef.current + totalSize + footerSize + paddingEnd + endSpaceRef.current;
    return Math.max(0, totalContent - viewportH + contentInsetBottomRef.current);
  }, [footerSize, paddingEnd, readTotalSize]);

  const clampScrollOffset = useCallback(
    (offset: number) => Math.max(0, Math.min(offset, getMaxScrollOffset())),
    [getMaxScrollOffset],
  );

  const indexAtOffset = useCallback(
    (x: number): number => {
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
    },
    [itemCount, readItemOffset],
  );

  useEffect(() => {
    emitFirstVisibleRef.current = () => {
      const cb = onFirstVisibleItemChangedRef.current;
      if (cb == null) return;
      if (itemCount === 0 || mainViewportRef.current <= 0) {
        lastFirstVisibleIndexRef.current = -1;
        return;
      }
      const engineOffset = lastScrollOffsetRef.current - effectivePaddingStartRef.current;
      const index = indexAtOffset(Math.max(0, engineOffset));
      if (index === lastFirstVisibleIndexRef.current) return;
      const item = items[index];
      if (item === undefined) return;
      lastFirstVisibleIndexRef.current = index;
      cb({index, item, key: keyExtractor ? keyExtractor(item, index) : String(index)});
    };
    emitFirstVisibleRef.current();
  }, [items, itemCount, keyExtractor, indexAtOffset]);

  const updateAlignPad = useCallback(() => {
    if (!alignItemsAtEnd) {
      setAlignPad(0);
      return;
    }
    const viewportH = mainViewportRef.current;
    const content = paddingStart + headerSize + readTotalSize() + footerSize + paddingEnd;
    setAlignPad(Math.max(0, Math.round((viewportH - content) * 8) / 8));
  }, [alignItemsAtEnd, paddingStart, headerSize, footerSize, paddingEnd, readTotalSize]);
  updateAlignPadRef.current = updateAlignPad;
  useEffect(() => {
    updateAlignPad();
  }, [updateAlignPad, range.layoutVersion, itemCount]);

  const updateEndSpace = useCallback(() => {
    const config = anchoredEndSpaceRef.current;
    if (config == null || itemCount === 0) {
      if (endSpaceRef.current !== 0) {
        endSpaceRef.current = 0;
        setEndSpace(0);
        config?.onSizeChanged?.(0);
      }
      return;
    }
    const viewportH = mainViewportRef.current;
    if (viewportH <= 0) return;
    const anchor = Math.max(0, Math.min(Math.trunc(config.anchorIndex), itemCount - 1));
    let tail = readTotalSize() - readItemOffset(anchor);
    const anchorSize = readItemSize(anchor);
    if (config.anchorMaxSize != null && anchorSize > config.anchorMaxSize) {
      tail -= anchorSize - config.anchorMaxSize;
    }
    const space = Math.max(
      0,
      Math.round(
        (viewportH - (config.anchorOffset ?? 0) - tail - footerSize - paddingEnd) * 8,
      ) / 8,
    );
    if (space !== endSpaceRef.current) {
      endSpaceRef.current = space;
      setEndSpace(space);
      config.onSizeChanged?.(space);
    }
    const ready = anchoredReadyRef.current;
    if (ready.anchorIndex !== anchor) {
      ready.anchorIndex = anchor;
      ready.fired = false;
    }
    if (!ready.fired && config.onReady != null) {
      const measured = measuredTailIndicesRef.current;
      let allMeasured = true;
      for (let i = anchor; i < itemCount; i++) {
        if (!measured.has(i)) {
          allMeasured = false;
          break;
        }
      }
      if (allMeasured) {
        ready.fired = true;
        config.onReady();
      }
    }
  }, [itemCount, footerSize, paddingEnd, readItemOffset, readItemSize, readTotalSize]);
  updateEndSpaceRef.current = updateEndSpace;
  useEffect(() => {
    updateEndSpace();
  }, [updateEndSpace, range.layoutVersion, items, anchoredEndSpace]);

  const [snapOffsets, setSnapOffsets] = useState<number[] | undefined>(undefined);
  const snapIndicesKey = snapToIndices != null ? snapToIndices.join(',') : '';
  useEffect(() => {
    if (snapToIndices == null || snapToIndices.length === 0 || itemCount === 0) {
      setSnapOffsets(undefined);
      return;
    }
    const next: number[] = [];
    for (const index of snapToIndices) {
      if (index < 0 || index >= itemCount) continue;
      next.push(effectivePaddingStartRef.current + readItemOffset(index));
    }
    next.sort((a, b) => a - b);
    setSnapOffsets((prev) => {
      if (prev != null && prev.length === next.length && prev.every((v, i) => v === next[i])) {
        return prev;
      }
      return next;
    });
  }, [snapIndicesKey, snapToIndices, itemCount, range.layoutVersion, readItemOffset, effectivePaddingStart]);

  const handleHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    const layout = e.nativeEvent.layout;
    const size = isHorizontalRef.current ? layout.width : layout.height;
    setHeaderSize((prev) => (Math.abs(prev - size) > MEASUREMENT_NOISE_EPSILON_DP ? size : prev));
  }, []);
  const handleFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const layout = e.nativeEvent.layout;
    const size = isHorizontalRef.current ? layout.width : layout.height;
    setFooterSize((prev) => (Math.abs(prev - size) > MEASUREMENT_NOISE_EPSILON_DP ? size : prev));
  }, []);
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
      const engineOffset = target - effectivePaddingStartRef.current;
      const velocitySample = scrollVelocityRef.current;
      velocitySample.velocity = 0;
      velocitySample.time = 0;
      resetVelocityRing(velocityRingRef.current);
      hybridRef.current?.resetScrollVelocity();
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      uiScrollOffsetSv.value = engineOffset;
      applyScrollOffsetSync(engineOffset);
      updateSticky(engineOffset);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      endProgrammaticAnimatedScroll();
      if (animated) {
        scrollActivityRef.current.programmaticAnimated = true;
        programmaticAnimatedTimerRef.current = setTimeout(() => {
          programmaticAnimatedTimerRef.current = null;
          if (!scrollActivityRef.current.programmaticAnimated) return;
          scrollActivityRef.current.programmaticAnimated = false;
          flushPendingMvcpAdjust();
          resolveAnimatedScrollCommand();
        }, PROGRAMMATIC_ANIMATED_SETTLE_FALLBACK_MS);
      }
      if (isHorizontalRef.current) {
        scrollRef.current?.scrollTo({x: target, y: 0, animated});
      } else {
        scrollRef.current?.scrollTo({y: target, animated});
      }
      return target;
    },
    [
      applyScrollOffsetSync,
      clampScrollOffset,
      updateSticky,
      uiScrollOffsetSv,
      endProgrammaticAnimatedScroll,
      flushPendingMvcpAdjust,
      resolveAnimatedScrollCommand,
    ],
  );


  useEffect(() => {
    applyMvcpCorrectionRef.current = (diff: number) => {
      const anchor = mvcpStateRef.current.anchor;
      if (anchor != null) {
        anchor.offset += diff;
      }
      const activity = scrollActivityRef.current;
      if (activity.dragging || activity.momentum || activity.programmaticAnimated) {
        activity.pendingAdjust += diff;
        return;
      }
      const from = lastScrollOffsetRef.current;
      const executable = computeExecutableMvcpDelta(from, diff, getMaxScrollOffset());
      if (executable === 0) return;
      const to = from + executable;
      lastScrollOffsetRef.current = to;
      const engineOffset = to - effectivePaddingStartRef.current;
      const velocitySample = scrollVelocityRef.current;
      velocitySample.velocity = 0;
      velocitySample.time = 0;
      resetVelocityRing(velocityRingRef.current);
      hybridRef.current?.resetScrollVelocity();
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      uiScrollOffsetSv.value = engineOffset;
      applyScrollOffsetSync(engineOffset);
      updateSticky(engineOffset);
      evaluateViewabilityRef.current();
      checkEdgeCallbacksRef.current();
      setMvcpAdjust((prev) => prev + executable);
    };
  }, [applyScrollOffsetSync, updateSticky, getMaxScrollOffset, uiScrollOffsetSv]);

  useEffect(() => {
    prewarmFlingDestinationRef.current = () => {
      if (itemCount === 0 || isPrewarmingRangeRef.current) return;
      const viewportH = mainViewportRef.current;
      if (viewportH <= 0) return;
      const velocity = scrollVelocityRef.current.velocity;
      const maxTravel = viewportH * FLING_MAX_TRAVEL_VIEWPORTS;
      const travel = Math.max(-maxTravel, Math.min(maxTravel, velocity * FLING_TRAVEL_FACTOR));
      if (Math.abs(travel) <= drawDistance) return;
      const destination = clampScrollOffset(lastScrollOffsetRef.current + travel);
      const destEngineTop = destination - effectivePaddingStartRef.current;
      let destStart = indexAtOffset(Math.max(0, destEngineTop - drawDistance));
      let destEnd = indexAtOffset(destEngineTop + viewportH + drawDistance);
      if (destEnd - destStart + 1 > FLING_PREWARM_MAX_ITEMS) {
        destStart = indexAtOffset(Math.max(0, destEngineTop));
        destEnd = Math.min(
          destStart + FLING_PREWARM_MAX_ITEMS - 1,
          indexAtOffset(destEngineTop + viewportH),
        );
      }
      const live = latestRangeRef.current;
      if (destStart >= live.start && destEnd <= live.end) return;
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
        if (flingAdmissionRef.current !== admission) return;
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
          admission.rafId = null;
          return;
        }
        admission.rafId = requestAnimationFrame(admitSlice);
      };
      admitSlice();
    };
  }, [itemCount, drawDistance, clampScrollOffset, indexAtOffset, cancelFlingPrewarm]);

  useEffect(() => {
    recordFlingOutcomeRef.current = (finalAbsoluteY: number) => {
      if (!NITRO_LIST_PERF_COMPILED || !NitroListPerfMonitor.enabled) return;
      const admission = flingAdmissionRef.current;
      if (admission == null) return;
      const viewportH = mainViewportRef.current;
      if (viewportH <= 0 || itemCount === 0) return;
      const engineTop = finalAbsoluteY - effectivePaddingStartRef.current;
      const first = indexAtOffset(Math.max(0, engineTop));
      const last = Math.max(first, indexAtOffset(engineTop + viewportH));
      const admitted = admission.admitted;
      NitroListPerfMonitor.recordFlingPrewarmOutcome(
        admitted != null && rangeCovers(admitted, {start: first, end: last}),
      );
    };
  }, [itemCount, indexAtOffset]);

  const prewarmRenderWindow = useCallback(
    (offset: number) => {
      const target = clampScrollOffset(offset);
      hybridRef.current?.resetScrollVelocity();
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      applyScrollOffsetSync(target - effectivePaddingStartRef.current);
      return target;
    },
    [applyScrollOffsetSync, clampScrollOffset],
  );

  const computeIndexScrollOffset = useCallback(
    (index: number, viewPosition: number, viewOffset: number) => {
      if (index < 0 || index >= itemCount) return null;
      const top = readItemOffset(index);
      const itemH = readItemSize(index);
      const viewportH = mainViewportRef.current;
      const target =
        effectivePaddingStartRef.current + top - viewPosition * (viewportH - itemH) + viewOffset;
      return clampScrollOffset(target);
    },
    [clampScrollOffset, itemCount, readItemOffset, readItemSize],
  );

  const computeStartScrollOffset = useCallback(
    (finalOffset: number, lastAbsoluteScrollOffset: number) => {
      const viewportH = mainViewportRef.current;
      const buffer = viewportH * SCROLL_TO_INDEX_BUFFER_MULTIPLIER;
      if (finalOffset > lastAbsoluteScrollOffset) {
        return clampScrollOffset(Math.max(finalOffset - buffer, lastAbsoluteScrollOffset));
      }
      return clampScrollOffset(Math.min(finalOffset + buffer, lastAbsoluteScrollOffset));
    },
    [clampScrollOffset],
  );

  const scrollToIndexConverge = useCallback(
    async ({
      index,
      animated = false,
      viewPosition = 0,
      viewOffset = 0,
    }: NitroListScrollToIndexParams) => {
      if (index < 0 || index >= itemCount) return;

      const commandId = beginScrollCommand();
      const devStartedAt = NITRO_LIST_PERF_COMPILED ? Date.now() : 0;
      let devRestarts = 0;
      let devCorrectionPasses = 0;
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordScrollToIndexStart();
      isPrewarmingRangeRef.current = false;
      lastPrewarmRangeRef.current = null;
      cancelFlingPrewarm();
      setPrewarmRange(null);

      await awaitScrollReadiness(commandId);
      if (commandId !== scrollCommandIdRef.current) return;

      let finalOffset = computeIndexScrollOffset(index, viewPosition, viewOffset);
      if (finalOffset == null) return;

      if (animated) {
        const viewportH = mainViewportRef.current;
        if (viewportH > 0) {
          const destEngineTop = finalOffset - effectivePaddingStartRef.current;
          const destStart = indexAtOffset(Math.max(0, destEngineTop));
          const destEnd = Math.max(destStart, indexAtOffset(destEngineTop + viewportH));
          setPrewarmRange({
            start: destStart,
            end: destEnd,
            layoutVersion: lastSeenLayoutVersionRef.current,
          });
        }
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
        if (correctedOffset == null) {
          setPrewarmRange(null);
          return;
        }
        if (
          Math.abs(correctedOffset - lastScrollOffsetRef.current) <= SCROLL_TO_INDEX_TARGET_EPSILON
        ) {
          break;
        }
        scrollToAbsoluteOffset(correctedOffset, false);
      }
      setPrewarmRange(null);
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
      indexAtOffset,
      prewarmRenderWindow,
      scrollToAbsoluteOffset,
      cancelFlingPrewarm,
      beginScrollCommand,
      awaitScrollReadiness,
    ],
  );

  const scrollToIndexPrecisely = useCallback(
    async (params: NitroListScrollToIndexParams) => {
      acquireEstimateFreeze();
      try {
        const idBefore = scrollCommandIdRef.current;
        const converge = scrollToIndexConverge(params);
        const commandId = scrollCommandIdRef.current;
        if (commandId === idBefore) {
          await converge;
          return;
        }
        await Promise.race([converge, trackScrollCommand(commandId)]);
        resolveScrollCommand(commandId);
      } finally {
        releaseEstimateFreeze();
      }
    },
    [
      scrollToIndexConverge,
      acquireEstimateFreeze,
      releaseEstimateFreeze,
      trackScrollCommand,
      resolveScrollCommand,
    ],
  );

  const scrollToEndPrecisely = useCallback(
    (animated: boolean): Promise<void> => {
      if (itemCount === 0) {
        const commandId = beginScrollCommand();
        scrollToAbsoluteOffset(getMaxScrollOffset(), animated);
        const promise = trackScrollCommand(commandId);
        if (animated) {
          animatedScrollResolverRef.current = () => resolveScrollCommand(commandId);
        } else {
          requestAnimationFrame(() => resolveScrollCommand(commandId));
        }
        return promise;
      }
      return scrollToIndexPrecisely({
        index: itemCount - 1,
        animated,
        viewPosition: 1,
        viewOffset: footerSize + paddingEnd + endSpaceRef.current + contentInsetBottomRef.current,
      });
    },
    [
      itemCount,
      footerSize,
      paddingEnd,
      scrollToIndexPrecisely,
      scrollToAbsoluteOffset,
      getMaxScrollOffset,
      beginScrollCommand,
      trackScrollCommand,
      resolveScrollCommand,
    ],
  );
  useEffect(() => {
    scrollToEndForMaintainRef.current = scrollToEndPrecisely;
  }, [scrollToEndPrecisely]);

  const initialPassRef = useRef<() => {diff: number; visKey: string} | null>(() => null);
  useEffect(() => {
    initialPassRef.current = () => {
      const initial = initialTargetRef.current;
      if (initial == null || itemCount === 0) return null;
      let corrected: number | null;
      if (initial.endAligned) {
        corrected = getMaxScrollOffset();
      } else if (initial.index != null) {
        corrected = computeIndexScrollOffset(initial.index, 0, 0);
      } else {
        corrected = clampScrollOffset(initial.offset);
      }
      if (corrected == null) return null;
      const diff = corrected - lastScrollOffsetRef.current;
      if (Math.abs(diff) > SCROLL_TO_INDEX_TARGET_EPSILON) {
        scrollToAbsoluteOffset(corrected, false);
      }
      const engineTop = Math.max(0, lastScrollOffsetRef.current - effectivePaddingStartRef.current);
      const first = indexAtOffset(engineTop);
      const last = Math.max(first, indexAtOffset(engineTop + mainViewportRef.current));
      return {diff: Math.abs(diff), visKey: `${first}:${last}`};
    };
  }, [
    itemCount,
    getMaxScrollOffset,
    computeIndexScrollOffset,
    clampScrollOffset,
    scrollToAbsoluteOffset,
    indexAtOffset,
  ]);

  useEffect(() => {
    if (!initialRevealPending) return;
    const timer = setTimeout(() => setInitialRevealPending(false), INITIAL_REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [initialRevealPending]);

  useEffect(() => {
    const initial = initialTargetRef.current;
    if (initial == null || initial.settled) return;
    if (range.end < 0) return;
    if (!initial.endAligned && initial.index != null && initial.index >= itemCount) return;
    if (initial.endAligned && itemCount === 0) return;
    initial.settled = true;
    void (async () => {
      try {
        if (initial.endAligned) {
          await scrollToEndPrecisely(false);
        } else if (initial.index != null) {
          await scrollToIndexPrecisely({index: initial.index, animated: false});
        } else {
          scrollToAbsoluteOffset(initial.offset, false);
        }
        const commandToken = scrollCommandIdRef.current;
        let stablePasses = 0;
        let lastVisKey = '';
        for (
          let pass = 0;
          pass < INITIAL_REVEAL_MAX_PASSES && stablePasses < INITIAL_REVEAL_STABLE_PASSES;
          pass++
        ) {
          if (scrollCommandIdRef.current !== commandToken) break;
          const result = initialPassRef.current();
          if (result == null) break;
          if (result.diff <= SCROLL_TO_INDEX_TARGET_EPSILON && result.visKey === lastVisKey) {
            stablePasses++;
          } else {
            stablePasses = 0;
          }
          lastVisKey = result.visKey;
          await waitForLayoutPass();
        }
      } finally {
        setInitialRevealPending(false);
      }
    })();
  }, [
    range,
    itemCount,
    scrollToIndexPrecisely,
    scrollToAbsoluteOffset,
    scrollToEndPrecisely,
  ]);

  useEffect(() => {
    const engineOffset = lastScrollOffsetRef.current - effectivePaddingStart;
    if (hybridRef.current && lastPushedEngineOffsetRef.current !== engineOffset) {
      const activity = scrollActivityRef.current;
      if (!uiThreadDriverActiveRef.current || (!activity.dragging && !activity.momentum)) {
        hybridRef.current.setScrollOffset(engineOffset);
        lastPushedEngineOffsetRef.current = engineOffset;
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
    }
    updateSticky(engineOffset);
    evaluateViewabilityRef.current();
    emitFirstVisibleRef.current();
  }, [range.layoutVersion, updateSticky, effectivePaddingStart]);

  useEffect(() => {
    if (hasFiredOnLoadRef.current) return;
    if (range.end < range.start) return;
    hasFiredOnLoadRef.current = true;
    onLoad?.({elapsedTimeInMs: Date.now() - mountTimestampRef.current});
  }, [range, onLoad]);

  useEffect(() => {
    if (drawDistanceExpanded) return;
    if (range.end < range.start) return;
    const raf = requestAnimationFrame(() => setDrawDistanceExpanded(true));
    return () => cancelAnimationFrame(raf);
  }, [drawDistanceExpanded, range]);

  const scrollIndexIntoViewImpl = useCallback(
    (index: number, animated: boolean, viewOffset: number): Promise<void> => {
      if (index < 0 || index >= itemCount) return Promise.resolve();
      const viewportMain = mainViewportRef.current;
      const itemTop = effectivePaddingStartRef.current + readItemOffset(index);
      const itemBottom = itemTop + readItemSize(index);
      const visibleTop = lastScrollOffsetRef.current + viewOffset;
      const visibleBottom =
        lastScrollOffsetRef.current + viewportMain - contentInsetBottomRef.current;
      if (itemTop >= visibleTop && itemBottom <= visibleBottom) {
        return Promise.resolve();
      }
      const alignToEnd = itemBottom > visibleBottom && itemTop >= visibleTop;
      return scrollToIndexPrecisely({
        index,
        animated,
        viewPosition: alignToEnd ? 1 : 0,
        viewOffset: alignToEnd ? contentInsetBottomRef.current : viewOffset,
      });
    },
    [itemCount, readItemOffset, readItemSize, scrollToIndexPrecisely],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToOffset({offset, animated = false}: NitroListScrollToOffsetParams) {
        const commandId = beginScrollCommand();
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
        scrollToAbsoluteOffset(offset, animated);
        const promise = trackScrollCommand(commandId);
        if (animated) {
          animatedScrollResolverRef.current = () => resolveScrollCommand(commandId);
        } else {
          requestAnimationFrame(() => resolveScrollCommand(commandId));
        }
        return promise;
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
        isPrewarmingRangeRef.current = false;
        lastPrewarmRangeRef.current = null;
        cancelFlingPrewarm();
        setPrewarmRange(null);
        return scrollToEndPrecisely(animated);
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
        const offset = readItemOffset(index);
        const size = readItemSize(index);
        if (isHorizontalRef.current) {
          return {x: offset, y: 0, width: size, height: crossViewportRef.current};
        }
        return {x: 0, y: offset, width: crossViewportRef.current, height: size};
      },
      getWindowSize() {
        return {
          width: viewportSizeRef.current.width,
          height: viewportSizeRef.current.height,
        };
      },
      getFirstItemOffset() {
        return effectivePaddingStart;
      },
      getScrollableNode() {
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
      scrollIndexIntoView({
        index,
        animated = false,
        viewOffset = 0,
      }: {
        index: number;
        animated?: boolean;
        viewOffset?: number;
      }) {
        return scrollIndexIntoViewImpl(index, animated, viewOffset);
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
        let index = (items as ReadonlyArray<unknown>).indexOf(item);
        if (index < 0 && keyExtractor != null && item != null) {
          const wantedKey = keyExtractor(item as T, 0);
          for (let i = 0; i < itemCount; i++) {
            if (keyExtractor(items[i], i) === wantedKey) {
              index = i;
              break;
            }
          }
        }
        if (index < 0) return Promise.resolve();
        return scrollIndexIntoViewImpl(index, animated, viewOffset);
      },
      reportContentInset({bottom = 0}: {bottom?: number}) {
        const next = Number.isFinite(bottom) ? Math.max(0, bottom) : 0;
        if (next === contentInsetBottomRef.current) return;
        contentInsetBottomRef.current = next;
        checkEdgeCallbacksRef.current();
      },
      getAverageItemSizes() {
        const result: Record<string, {average: number; count: number}> = {};
        const hybrid = hybridRef.current;
        if (hybrid == null) return result;
        let stats = new Float64Array((typeIdMapRef.current.size + 2) * 3);
        let written = hybrid.fillTypeStats(stats.buffer);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
        if (written < 0) {
          stats = new Float64Array(4096 * 3);
          written = hybrid.fillTypeStats(stats.buffer);
          if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
          if (written < 0) return result;
        }
        const idToType = new Map<number, ItemTypeKey>();
        for (const [type, id] of typeIdMapRef.current) idToType.set(id, type);
        for (let k = 0; k < written; k++) {
          const id = stats[k * 3] | 0;
          const label = id === 0 ? '' : String(idToType.get(id) ?? id);
          result[label] = {average: stats[k * 3 + 1], count: stats[k * 3 + 2]};
        }
        return result;
      },
    }),
    [
      itemCount,
      effectivePaddingStart,
      scrollToAbsoluteOffset,
      scrollToIndexPrecisely,
      scrollToEndPrecisely,
      readItemOffset,
      readItemSize,
      readTotalSize,
      cancelFlingPrewarm,
      beginScrollCommand,
      trackScrollCommand,
      resolveScrollCommand,
      scrollIndexIntoViewImpl,
      items,
      keyExtractor,
    ],
  );

  const alwaysRenderKeysJoined = alwaysRender?.keys != null ? alwaysRender.keys.join(' ') : '';
  const alwaysRenderKeyIndices = useMemo<number[] | null>(() => {
    const keys = alwaysRender?.keys;
    if (keys == null || keys.length === 0 || keyExtractor == null) return null;
    const wanted = new Set(keys);
    const found: number[] = [];
    for (let i = 0; i < items.length && found.length < wanted.size; i++) {
      if (wanted.has(keyExtractor(items[i], i))) found.push(i);
    }
    return found;
  }, [alwaysRenderKeysJoined, items, keyExtractor]);

  const renderedChildren: React.ReactNode[] = [];
  const renderRanges: RenderRange[] = [];
  pushRenderRange(renderRanges, range, itemCount);
  pushRenderRange(renderRanges, prewarmRange, itemCount);
  if (alwaysRender != null && itemCount > 0) {
    if (alwaysRender.top != null && alwaysRender.top > 0) {
      pushRenderRange(renderRanges, {start: 0, end: alwaysRender.top - 1}, itemCount);
    }
    if (alwaysRender.bottom != null && alwaysRender.bottom > 0) {
      pushRenderRange(
        renderRanges,
        {start: itemCount - alwaysRender.bottom, end: itemCount - 1},
        itemCount,
      );
    }
    if (alwaysRender.indices != null) {
      for (const index of alwaysRender.indices) {
        pushRenderRange(renderRanges, {start: index, end: index}, itemCount);
      }
    }
    if (alwaysRenderKeyIndices != null) {
      for (const index of alwaysRenderKeyIndices) {
        pushRenderRange(renderRanges, {start: index, end: index}, itemCount);
      }
    }
  }
  if (anchoredEndSpace != null && itemCount > 0) {
    pushRenderRange(
      renderRanges,
      {
        start: Math.max(0, Math.min(Math.trunc(anchoredEndSpace.anchorIndex), itemCount - 1)),
        end: itemCount - 1,
      },
      itemCount,
    );
  }

  const effectiveRenderMode: NitroListRenderMode =
    adaptiveRenderMode === true ? renderMode : 'normal';
  const seenRenderKeys = IS_DEV ? new Set<string>() : null;
  for (const {start, end} of mergeRenderRanges(renderRanges)) {
    for (let i = start; i <= end; i++) {
      const item = items[i];
      const itemKey = keyExtractor ? keyExtractor(item, i) : String(i);
      if (seenRenderKeys != null) checkDuplicateKeyDev(seenRenderKeys, itemKey);
      const itemType = getItemType ? getItemType(item, i) : undefined;
      const reactKey = itemType !== undefined ? `${itemType}:${itemKey}` : itemKey;
      const top = readItemOffset(i);
      const isHiddenStickyCell = hideRelatedCell && i === stickyIndexState;
      if (isHiddenStickyCell) {
        const naturalHeight = readItemSize(i);
        renderedChildren.push(
          <HiddenStickyCell
            key={reactKey}
            top={top}
            height={naturalHeight}
            horizontal={isHorizontal}
          />,
        );
      } else {
        renderedChildren.push(
          <NitroListItemContainer
            key={reactKey}
            index={i}
            top={top}
            horizontal={isHorizontal}
            columnLeft={
              columnLayout != null
                ? `${(columnLayout.colOf[i] / resolvedColumns) * 100}%`
                : undefined
            }
            columnWidth={
              columnLayout != null
                ? `${(columnLayout.spans[i] / resolvedColumns) * 100}%`
                : undefined
            }
            mainAxisGap={mainAxisGap}
            crossAxisGap={crossAxisGap}
            renderMode={effectiveRenderMode}
            item={item as unknown}
            renderItem={renderItem as NitroListRenderItem<unknown>}
            SeparatorComponent={
              ItemSeparatorComponent as React.ComponentType<{leadingItem: unknown}> | undefined
            }
            isLastItem={i === itemCount - 1}
            enqueueItemSize={enqueueItemSize}
            fixedSize={getFixedItemSize?.(item, i, itemType)}
            itemsAreEqual={itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined}
          />,
        );
      }
    }
  }

  const totalSize = readTotalSize();

  const stickyItem =
    stickyIndexState >= 0 && stickyIndexState < itemCount ? items[stickyIndexState] : undefined;

  return (
    <View style={[styles.wrapper, style, initialRevealPending ? styles.hiddenUntilReveal : null]}>
      {resolvedRenderScrollComponent({
        ref: scrollRef,
        horizontal: isHorizontal,
        snapToOffsets: snapOffsets,
        onScroll: uiThreadDriverActive ? uiThreadScrollHandler : handleOuterScroll,
        onScrollBeginDrag: handleScrollBeginDrag,
        onScrollEndDrag: handleScrollEndDrag,
        onMomentumScrollBegin: handleMomentumScrollBegin,
        onMomentumScrollEnd: handleMomentumScrollEnd,
        onLayout: handleOuterLayout,
        scrollEventThrottle: experimentalUiThreadScroll === true ? 1 : 16,
        contentContainerStyle,
        contentOffset: initialContentOffset,
        maintainVisibleContentPosition: mvcpEnabled ? MVCP_SCROLL_VIEW_CONFIG : undefined,
        children: (
          <>
            {mvcpEnabled ? (
              <MvcpAdjustAnchor top={MVCP_ANCHOR_BASE + mvcpAdjust} horizontal={isHorizontal} />
            ) : null}
            {alignPad > 0 ? (
              <View style={isHorizontal ? {width: alignPad} : {height: alignPad}} />
            ) : null}
            {ListHeaderComponent != null ? (
              <View onLayout={handleHeaderLayout}>{renderSlot(ListHeaderComponent)}</View>
            ) : null}
            {itemCount === 0 ? renderSlot(ListEmptyComponent) : null}
            <NitroListView
              hybridRef={hybridRefCb}
              style={isHorizontal ? {width: totalSize} : {height: totalSize}}
              itemCount={itemCount}
              estimatedItemSize={estimatedItemSize}
              drawDistance={effectiveDrawDistance}
              horizontal={isHorizontal}
              numColumns={resolvedColumns}
              onRangeChange={onRangeChangeCb}>
              {renderedChildren}
            </NitroListView>
            {ListFooterComponent != null ? (
              <View onLayout={handleFooterLayout}>{renderSlot(ListFooterComponent)}</View>
            ) : null}
            {endSpace > 0 ? (
              <View style={isHorizontal ? {width: endSpace} : {height: endSpace}} />
            ) : null}
          </>
        ),
      })}
      {stickyItem !== undefined ? (
        <StickyOverlay translateY={stickyTranslateYSv} horizontal={isHorizontal}>
          {renderItem({
            item: stickyItem,
            index: stickyIndexState,
            target: 'StickyHeader',
            renderMode: effectiveRenderMode,
          })}
        </StickyOverlay>
      ) : null}
    </View>
  );
}

type ItemsAreEqualFn = (prev: unknown, next: unknown, index: number) => boolean;

interface NitroListItemContainerProps {
  index: number;
  top: number;
  horizontal: boolean;
  columnLeft?: string;
  columnWidth?: string;
  mainAxisGap: number;
  crossAxisGap: number;
  renderMode: NitroListRenderMode;
  item: unknown;
  renderItem: NitroListRenderItem<unknown>;
  SeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  isLastItem: boolean;
  enqueueItemSize: (index: number, sizeDp: number) => void;
  fixedSize?: number;
  itemsAreEqual?: ItemsAreEqualFn;
}

function areItemsEquivalent(
  prevItem: unknown,
  nextItem: unknown,
  index: number,
  prevFn: ItemsAreEqualFn | undefined,
  nextFn: ItemsAreEqualFn | undefined,
): boolean {
  if (prevItem === nextItem) return true;
  return prevFn != null && prevFn === nextFn && prevFn(prevItem, nextItem, index);
}

function areItemContainerPropsEqual(
  prev: NitroListItemContainerProps,
  next: NitroListItemContainerProps,
): boolean {
  return (
    prev.top === next.top &&
    prev.horizontal === next.horizontal &&
    prev.columnLeft === next.columnLeft &&
    prev.columnWidth === next.columnWidth &&
    prev.mainAxisGap === next.mainAxisGap &&
    prev.crossAxisGap === next.crossAxisGap &&
    prev.renderMode === next.renderMode &&
    prev.index === next.index &&
    prev.renderItem === next.renderItem &&
    prev.SeparatorComponent === next.SeparatorComponent &&
    prev.isLastItem === next.isLastItem &&
    prev.enqueueItemSize === next.enqueueItemSize &&
    prev.fixedSize === next.fixedSize &&
    areItemsEquivalent(prev.item, next.item, next.index, prev.itemsAreEqual, next.itemsAreEqual)
  );
}

const MEASUREMENT_NOISE_EPSILON_DP = 1 / PixelRatio.get() + 0.01;
const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

interface NitroListCellContentProps {
  index: number;
  item: unknown;
  renderItem: NitroListRenderItem<unknown>;
  SeparatorComponent?: React.ComponentType<{leadingItem: unknown}>;
  isLastItem: boolean;
  renderMode: NitroListRenderMode;
  itemsAreEqual?: ItemsAreEqualFn;
}

function areCellContentPropsEqual(
  prev: NitroListCellContentProps,
  next: NitroListCellContentProps,
): boolean {
  return (
    prev.index === next.index &&
    prev.renderItem === next.renderItem &&
    prev.SeparatorComponent === next.SeparatorComponent &&
    prev.isLastItem === next.isLastItem &&
    prev.renderMode === next.renderMode &&
    areItemsEquivalent(prev.item, next.item, next.index, prev.itemsAreEqual, next.itemsAreEqual)
  );
}

const NitroListCellContent = React.memo(function NitroListCellContent({
  index,
  item,
  renderItem,
  SeparatorComponent,
  isLastItem,
  renderMode,
}: NitroListCellContentProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemContentRender();
  }
  return (
    <>
      {renderItem({item, index, target: 'Cell', renderMode})}
      {SeparatorComponent != null && !isLastItem ? <SeparatorComponent leadingItem={item} /> : null}
    </>
  );
}, areCellContentPropsEqual);

const NitroListItemContainer = React.memo(function NitroListItemContainer({
  index,
  top,
  horizontal,
  columnLeft,
  columnWidth,
  mainAxisGap,
  crossAxisGap,
  renderMode,
  item,
  renderItem,
  SeparatorComponent,
  isLastItem,
  enqueueItemSize,
  fixedSize,
  itemsAreEqual,
}: NitroListItemContainerProps) {
  if (NITRO_LIST_PERF_COMPILED) {
    NitroListPerfMonitor.recordItemRender();
  }
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
      const layout = e.nativeEvent.layout;
      const size = (horizontal ? layout.width : layout.height) + mainAxisGap;
      if (
        lastReportedRef.current >= 0 &&
        Math.abs(size - lastReportedRef.current) <= MEASUREMENT_NOISE_EPSILON_DP
      ) {
        return;
      }
      lastReportedRef.current = size;
      enqueueItemSize(index, size);
    },
    [index, horizontal, mainAxisGap, enqueueItemSize],
  );
  const verifyFixedSizeLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const layout = e.nativeEvent.layout;
      const height = horizontal ? layout.width : layout.height;
      if (fixedSize != null && Math.abs(height - fixedSize) > MEASUREMENT_NOISE_EPSILON_DP) {
        warnDevOnce(
          'fixed-item-size-mismatch',
          `getFixedItemSize returned ${fixedSize} for index ${index}, but the cell measured ` +
            `${height}. Fixed-size cells skip measurement, so the fixed value wins and items ` +
            `after this one will overlap or gap. Fix getFixedItemSize or remove it for this item.`,
        );
      }
    },
    [fixedSize, index, horizontal],
  );
  const containerStyle = useMemo(() => {
    if (columnLeft != null && columnWidth != null) {
      return [
        styles.absoluteCell,
        {
          top,
          left: columnLeft as unknown as number,
          width: columnWidth as unknown as number,
          paddingLeft: crossAxisGap / 2,
          paddingRight: crossAxisGap / 2,
        },
      ];
    }
    return horizontal ? [styles.absoluteColumn, {left: top}] : [styles.absoluteRow, {top}];
  }, [horizontal, top, columnLeft, columnWidth, crossAxisGap]);
  return (
    <View
      collapsable={false}
      onLayout={fixedSize == null ? handleLayout : IS_DEV ? verifyFixedSizeLayout : undefined}
      style={containerStyle}>
      <NitroListCellContent
        index={index}
        item={item}
        renderItem={renderItem}
        SeparatorComponent={SeparatorComponent}
        isLastItem={isLastItem}
        renderMode={renderMode}
        itemsAreEqual={itemsAreEqual}
      />
    </View>
  );
}, areItemContainerPropsEqual);

const MvcpAdjustAnchor = React.memo(function MvcpAdjustAnchor({
  top,
  horizontal,
}: {
  top: number;
  horizontal: boolean;
}) {
  const style = useMemo(
    () =>
      horizontal
        ? [styles.mvcpAnchorHorizontal, {left: top}]
        : [styles.mvcpAnchor, {top}],
    [horizontal, top],
  );
  return <View collapsable={false} style={style} />;
});

interface HiddenStickyCellProps {
  top: number;
  height: number;
  horizontal: boolean;
}

const HiddenStickyCell = React.memo(function HiddenStickyCell({
  top,
  height,
  horizontal,
}: HiddenStickyCellProps) {
  const style = useMemo(
    () =>
      horizontal
        ? [styles.absoluteColumn, {left: top, width: height}]
        : [styles.absoluteRow, {top, height}],
    [horizontal, top, height],
  );
  return <View collapsable={false} style={style} />;
});

interface StickyOverlayProps {
  translateY: SharedValue<number>;
  horizontal: boolean;
  children: React.ReactNode;
}

const StickyOverlay = React.memo(function StickyOverlay({
  translateY,
  horizontal,
  children,
}: StickyOverlayProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: horizontal
      ? [{translateX: translateY.value}]
      : [{translateY: translateY.value}],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      collapsable={false}
      style={[horizontal ? styles.stickyOverlayHorizontal : styles.stickyOverlay, animatedStyle]}>
      {children}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    overflow: 'hidden',
  },
  hiddenUntilReveal: {
    opacity: 0,
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
  absoluteColumn: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  absoluteCell: {
    position: 'absolute',
  },
  stickyOverlayHorizontal: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  mvcpAnchor: {
    position: 'absolute',
    left: 0,
    width: 1,
    height: 1,
  },
  mvcpAnchorHorizontal: {
    position: 'absolute',
    top: 0,
    width: 1,
    height: 1,
  },
});

export const NitroList = forwardRef(NitroListInner) as <T>(
  props: NitroListProps<T> & {ref?: React.Ref<NitroListHandle>},
) => React.ReactElement | null;
