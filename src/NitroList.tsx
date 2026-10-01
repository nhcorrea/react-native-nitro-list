import {analyzeData} from './dataAnalysis';
import {DATA_CONFIG_LENGTH, writeDataConfig} from './dataTransaction';
import {emptyNativeBuffer, growNativeFloat64Array, nativeFloat64Array, nativeUint16Array} from './nativeBuffers';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PixelRatio,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {useAnimatedScrollHandler, useSharedValue} from 'react-native-reanimated';
import {scheduleOnUI} from 'react-native-worklets';

import {createNitroListEngine, reportEngineMemory, type NitroListEngine} from './NitroListHost';
import {scrollToNativeOffset} from './nativeScroll';
import {ListStore, type RangeState} from './listStore';
import {NITRO_LIST_PERF_COMPILED, NitroListPerfMonitor} from './PerfMonitor';
import {
  type AdmissionRange,
  growAdmittedRange,
  PREWARM_ADMISSION_BUDGET_ITEMS,
  rangeCovers,
} from './prewarmAdmission';
import {
  getCachedFixedSize,
  markMeasurementVariable,
  measurementCacheKey,
} from './measurementCache';
import {NitroListDevFlags} from './devFlags';
import {computeExecutableMvcpDelta} from './mvcp';
import {
  createScrollToIndex,
  type ScrollToIndexApi,
  type ScrollToIndexCtx,
} from './scrollToIndex';
import {noteScrollCommand, type NitroListScrollCommandEcho} from './scrollEvents';
import {firstDifferingIndex, type KeyRemapPairs} from './keyRemap';
import {
  EndSpaceSpacer,
  IS_DEV,
  ListContainer,
  MEASUREMENT_NOISE_EPSILON_DP,
  MvcpAdjustAnchorSlot,
  NitroListCells,
  StickyHeaderSlot,
  markCellSupplied,
  resupplyCellSize,
  type CellBridge,
  type ItemsAreEqualFn,
  type ItemTypeKey,
  type NitroListCellsProps,
} from './cells';
import {
  createEdgeCallbacks,
  type EdgeCallbacksCtx,
  type EdgeLatchState,
} from './edges';
import {computeSticky, createStickyResult, driveStickyOnUi} from './sticky';
import {createViewability, type ViewabilityCtx} from './viewability';
import {flushWaiters, waitForNextFrame} from './scrollCommands';
import {createMeasurement, type MeasurementApi, type MeasurementCtx} from './measurement';
import {createMeasurementRevision, isCurrentMeasurement, type MeasurementIdentity} from './measurementIdentity';
import {
  createLayoutCache,
  type LayoutCacheApi,
  type LayoutCacheCtx,
} from './layoutCache';
import {createDataChangeHandler, type DataChangeCtx} from './dataChanges';
import {createNitroListHandle, type HandleCtx} from './handle';
import {createGeometry, type GeometryApi, type GeometryCtx} from './geometry';
import {
  createRangePipeline,
  type RangePipelineApi,
  type RangePipelineCtx,
} from './rangePipeline';
import {
  createScrollHandlers,
  SCROLL_COMMAND_ECHO_MAX_AGE_MS,
  type ScrollHandlersApi,
  type ScrollHandlersCtx,
} from './scrollHandlers';
import {
  createInitialReveal,
  INITIAL_REVEAL_TIMEOUT_MS,
  type InitialRevealApi,
  type InitialRevealCtx,
} from './initialReveal';
import {
  createItemTypes,
  type ItemTypesApi,
  type ItemTypesCtx,
} from './itemTypes';
import {extractAxisPadding, renderSlot} from './listUtils';
import {publishStableCallbacks, useStableCallback, type StableCallbackBindings} from './stableCallbacks';
import {createUiScrollHandlers, type UiScrollContext} from './uiScrollHandlers';
import type {
  NitroListHandle,
  NitroListProps,
  NitroListRenderItem,
  NitroListRenderMode,
  NitroListRenderScrollComponent,
  NitroListViewToken,
} from './types';
import {createVelocityRing, resetVelocityRing} from './scrollVelocity';
import {
  maybeWarnJsOnScrollUnderUiDriver,
  maybeWarnZeroViewport,
  noteRenderItemIdentity,
  warnDevOnce,
  type EstimateDriftStats,
  type RenderItemChurn,
} from './devWarnings';

export type {
  NitroListAlwaysRenderConfig,
  NitroListAnchoredEndSpaceConfig,
  NitroListHandle,
  NitroListItemLayout,
  NitroListMaintainVisibleContentPositionConfig,
  NitroListOnViewableItemsChanged,
  NitroListProps,
  NitroListRangeChangeEvent,
  NitroListRenderItem,
  NitroListRenderMode,
  NitroListRenderScrollComponent,
  NitroListRenderScrollComponentProps,
  NitroListRenderTarget,
  NitroListScrollToIndexParams,
  NitroListScrollToOffsetParams,
  NitroListStickyHeaderConfig,
  NitroListViewToken,
  NitroListViewabilityConfig,
  NitroListWindowSize,
} from './types';
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
const MEASUREMENT_EPSILON_DP = 1 / PixelRatio.get() + 0.01;
const FLING_TRAVEL_FACTOR = Platform.OS === 'ios' ? 0.4995 : 0.3;
const FLING_MAX_TRAVEL_VIEWPORTS = 4;
const FLING_PREWARM_MAX_ITEMS = 80;
const ADAPTIVE_ENTER_DP_S = 3000;
const ADAPTIVE_EXIT_DP_S = 1000;
const ADAPTIVE_EXIT_DELAY_MS = 250;
const ENGINE_MEMORY_REPORT_MIN_ITEMS = 4096;

function watchZeroViewport(mainViewportRef: {current: number}, itemCount: number): () => void {
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
}

function isMvcpAnchorEligible<T>(
  items: ReadonlyArray<T>,
  shouldRestore: (item: T, index: number) => boolean,
  index: number,
): boolean {
  const candidate = items[index];
  return candidate === undefined || shouldRestore(candidate, index) !== false;
}

function scheduleRevealTimeout(setRevealPending: (pending: boolean) => void): () => void {
  const timer = setTimeout(() => setRevealPending(false), INITIAL_REVEAL_TIMEOUT_MS);
  return () => clearTimeout(timer);
}

function NitroListInner<T>(props: NitroListProps<T>, ref: React.Ref<NitroListHandle>) {
  // Publish bindings before child layout effects. This phase only assigns refs;
  // engine mutations and notifications remain in layout effects. Abandoned
  // renders never execute these publications.
  const commitBindings: Array<() => void> = [];
  const stableCallbacks: StableCallbackBindings = [];
  useInsertionEffect(() => {
    publishStableCallbacks(stableCallbacks);
    for (const publish of commitBindings) publish();
  });
  if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordOrchestratorRender();
  const {
    data,
    renderItem,
    estimatedItemSize,
    keyExtractor,
    getItemType,
    getFixedItemSize,
    autoFixedItemSizes,
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
  const renderItemChurnRef = useRef<RenderItemChurn>({last: undefined, streak: 0});
  if (IS_DEV) commitBindings.push(() => noteRenderItemIdentity(renderItemChurnRef.current, renderItem));
  const {fontScale} = useWindowDimensions();
  const hasKeyExtractor = keyExtractor != null;
  const hasItemType = getItemType != null;
  const hasFixedItemSize = getFixedItemSize != null;
  const hasItemLayoutOverride = overrideItemLayout != null;
  const hasSeparator = ItemSeparatorComponent != null;
  const analyzedCommitRef = useRef({items, dataVersion});
  const dataAnalysis = useMemo(() => analyzeData(analyzedCommitRef.current.items, items,
    !Object.is(analyzedCommitRef.current.dataVersion, dataVersion), keyExtractor),
    [items, dataVersion, hasKeyExtractor]);
  commitBindings.push(() => { analyzedCommitRef.current = {items, dataVersion}; });
  const storeRef = useRef<ListStore | null>(null);
  if (storeRef.current == null) {
    storeRef.current = new ListStore({
      range: {start: 0, end: -1, layoutVersion: 0},
      prewarmRange: null,
      stickyIndex: -1,
      totalSize: Math.max(0, itemCount * estimatedItemSize),
      autoFixedTypes: null,
      renderMode: 'normal',
      endSpace: 0,
      mvcpAdjust: 0,
    });
  }
  const store = storeRef.current;
  const stickyIndicesKey = stickyHeaderIndices != null ? stickyHeaderIndices.join(',') : '';
  const stickyIndices = useMemo<readonly number[]>(() => {
    const latest = stickyHeaderIndices;
    return latest != null && latest.length > 0 ? latest.slice() : NO_STICKY;
  }, [stickyIndicesKey]);
  const stickyOffset = stickyHeaderConfig?.offset ?? 0;
  const hideRelatedCell = stickyHeaderConfig?.hideRelatedCell ?? false;
  const stickySize = stickyHeaderConfig?.size;

  const isHorizontal = horizontal === true;
  const isHorizontalRef = useRef(isHorizontal);
  commitBindings.push(() => {
    isHorizontalRef.current = isHorizontal;
  });
  const {start: paddingStart, end: paddingEnd} = useMemo(
    () => extractAxisPadding(contentContainerStyle, isHorizontal),
    [contentContainerStyle, isHorizontal],
  );
  const crossPadding = useMemo(
    () => extractAxisPadding(contentContainerStyle, !isHorizontal),
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
  // A cache entry belongs to this list and constraint domain. Type labels
  // alone do not establish compatibility across lists or mixed spans.
  const measurementCacheDomain = useMemo(() => ({}), [
    hasItemType, hasSeparator, dataVersion, fontScale,
    isHorizontal, resolvedColumns, mainAxisGap, crossAxisGap, hasItemLayoutOverride,
  ]);
  const cacheEnabled = !hasItemLayoutOverride;
  const measurementRevision = useMemo(createMeasurementRevision, [
    measurementCacheDomain, hasFixedItemSize, hasKeyExtractor,
    crossPadding.start, crossPadding.end,
  ]);
  const [, setMeasurementGeometry] = useState(0);
  const measurementGeometry = measurementRevision.geometry;
  const columnsRef = useRef(resolvedColumns);
  commitBindings.push(() => {
    columnsRef.current = resolvedColumns;
  });
  const columnLayoutCacheRef = useRef<{
    items: ReadonlyArray<T>;
    resolvedColumns: number;
    hasItemLayoutOverride: boolean;
    layout: {spans: Uint16Array; colOf: Uint16Array; rowStarts: Int32Array};
  } | null>(null);
  const columnLayout = useMemo(() => {
    if (resolvedColumns <= 1 || itemCount === 0) return null;
    const cached = columnLayoutCacheRef.current;
    const reusable =
      NitroListDevFlags.dataAppendFastPath &&
      cached != null &&
      !dataAnalysis.versionChanged &&
      cached.resolvedColumns === resolvedColumns &&
      cached.hasItemLayoutOverride === hasItemLayoutOverride
        ? cached
        : null;
    const from = reusable != null ? Math.min(reusable.items === items ? itemCount : dataAnalysis.firstChanged, itemCount) : 0;
    const spans = nativeUint16Array(itemCount);
    const colOf = new Uint16Array(itemCount);
    const rowStarts = new Int32Array(itemCount);
    const layoutProbe = {span: 1};
    let used = 0;
    let rowStartIdx = 0;
    if (reusable != null && from > 0) {
      spans.set(reusable.layout.spans.subarray(0, from));
      colOf.set(reusable.layout.colOf.subarray(0, from));
      rowStarts.set(reusable.layout.rowStarts.subarray(0, from));
      used = colOf[from - 1] + spans[from - 1];
      if (used >= resolvedColumns) used = 0;
      rowStartIdx = rowStarts[from - 1];
    }
    if (NITRO_LIST_PERF_COMPILED && overrideItemLayout != null) {
      NitroListPerfMonitor.recordUserCallbacks(itemCount - from);
    }
    for (let i = from; i < itemCount; i++) {
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
    const layout = {spans, colOf, rowStarts, changedFrom: from};
    return layout;
  }, [resolvedColumns, itemCount, items, hasItemLayoutOverride, dataAnalysis]);
  commitBindings.push(() => {
    columnLayoutCacheRef.current = columnLayout == null ? null : {items, resolvedColumns, hasItemLayoutOverride, layout: columnLayout};
  });

  const [headerSize, setHeaderSize] = useState(0);
  const [footerSize, setFooterSize] = useState(0);
  const [alignPad, setAlignPad] = useState(0);
  const endSpaceRef = useRef(0);
  const anchoredEndSpaceRef = useRef(anchoredEndSpace);
  commitBindings.push(() => {
    anchoredEndSpaceRef.current = anchoredEndSpace;
  });
  const anchoredReadyRef = useRef<{anchorIndex: number; fired: boolean}>({
    anchorIndex: -1,
    fired: false,
  });
  const updateEndSpaceRef = useRef<() => void>(() => {});

  const effectivePaddingStart = paddingStart + headerSize + alignPad;
  const effectivePaddingStartRef = useRef(effectivePaddingStart);
  commitBindings.push(() => {
    effectivePaddingStartRef.current = effectivePaddingStart;
  });

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
  const effectiveDrawDistanceRef = useRef(effectiveDrawDistance);
  commitBindings.push(() => {
    effectiveDrawDistanceRef.current = effectiveDrawDistance;
  });

  const scrollRef = useRef<ScrollView>(null);
  const hybridRef = useRef<NitroListEngine | null>(null);
  const engineRef = useRef<NitroListEngine | null>(null);

  const stickyTranslateYSv = useSharedValue(stickyOffset);
  const uiStickyIndexSv = useSharedValue(-1);
  const stickyOverlaySizeSv = useSharedValue(stickySize ?? 0);
  const stickyOverlaySizeRef = useRef(stickySize ?? 0);
  const lastJsStickyTyRef = useRef<number | null>(null);
  const lastJsStickyIndexRef = useRef<number | null>(null);
  const stickyResultRef = useRef(createStickyResult());

  const layoutCacheCtxRef = useRef<LayoutCacheCtx | null>(null);
  if (layoutCacheCtxRef.current == null) {
    // Pinned cells can read estimated geometry on the first render, before
    // there is a published engine or live range.
    layoutCacheCtxRef.current = {engineRef: hybridRef,
      liveRangeRef: {current: {start: 0, end: -1}}, estimatedItemSize, itemCount};
  }
  const layoutCacheApiRef = useRef<LayoutCacheApi | null>(null);
  if (layoutCacheApiRef.current == null) {
    layoutCacheApiRef.current = createLayoutCache(layoutCacheCtxRef.current);
  }
  const layout = layoutCacheApiRef.current;
  const invalidateLayoutCache = layout.invalidate;
  const readItemOffset = layout.readItemOffset;
  const readItemSize = layout.readItemSize;
  const stickyLayoutReaderRef = useRef<{
    getItemOffset: (index: number) => number;
    getItemSize: (index: number) => number;
  } | null>(null);
  stickyLayoutReaderRef.current ??= {getItemOffset: readItemOffset, getItemSize: readItemSize};
  const stickyLayoutReader = stickyLayoutReaderRef.current;
  const ensureLayout = layout.ensureLayout;
  const readTotalSize = layout.readTotalSize;
  const writeSlabToCache = layout.writeSlab;
  const fillSlab = layout.fillSlab;


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
  commitBindings.push(() => {
    mvcpResolvedRef.current = {size: mvcpSizeEnabled, data: mvcpDataEnabled};
  });
  const mvcpShouldRestoreRef = useRef<((item: T, index: number) => boolean) | null>(null);
  commitBindings.push(() => {
    mvcpShouldRestoreRef.current = mvcpConfigObject?.shouldRestorePosition ?? null;
  });
  const mvcpStateRef = useRef<{
    enabled: boolean;
    anchor: {index: number; key: string | null; offset: number} | null;
  }>({enabled: false, anchor: null});
  commitBindings.push(() => {
    mvcpStateRef.current.enabled = mvcpEnabled;
  });
  commitBindings.push(() => {
    if (!mvcpEnabled) mvcpStateRef.current.anchor = null;
  });
  const applyMvcpCorrectionRef = useRef<(diff: number) => void>(() => {});
  const latestRangeRef = useRef<{start: number; end: number}>({start: 0, end: -1});

  commitBindings.push(() => {
    Object.assign(layoutCacheCtxRef.current!, {
      engineRef: hybridRef,
      liveRangeRef: latestRangeRef,
      estimatedItemSize,
      itemCount,
    } satisfies LayoutCacheCtx);
  });

  const isPrewarmingRangeRef = useRef(false);
  const scrollActivityRef = useRef<{
    dragging: boolean;
    momentum: boolean;
    programmaticAnimated: boolean;
    pendingAdjust: number;
  }>({dragging: false, momentum: false, programmaticAnimated: false, pendingAdjust: 0});
  const programmaticAnimatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticAnimatedScrollSeenRef = useRef(false);
  const animatedScrollResolverRef = useRef<(() => void) | null>(null);
  const resolveAnimatedScrollCommand = useStableCallback(stableCallbacks, () => {
    const resolver = animatedScrollResolverRef.current;
    if (resolver != null) {
      animatedScrollResolverRef.current = null;
      resolver();
    }
  });
  const endProgrammaticAnimatedScroll = useStableCallback(stableCallbacks, () => {
    if (programmaticAnimatedTimerRef.current != null) {
      clearTimeout(programmaticAnimatedTimerRef.current);
      programmaticAnimatedTimerRef.current = null;
    }
    scrollActivityRef.current.programmaticAnimated = false;
    resolveAnimatedScrollCommand();
  });
  useEffect(() => endProgrammaticAnimatedScroll, [endProgrammaticAnimatedScroll]);
  const scrollVelocityRef = useRef<{offset: number; time: number; velocity: number}>({
    offset: 0,
    time: 0,
    velocity: 0,
  });
  const velocityRingRef = useRef(createVelocityRing());
  const adaptiveEnabledRef = useRef(adaptiveRenderMode === true);
  commitBindings.push(() => {
    adaptiveEnabledRef.current = adaptiveRenderMode === true;
  });
  const adaptiveStateRef = useRef<{
    mode: NitroListRenderMode;
    timer: ReturnType<typeof setTimeout> | null;
  }>({mode: 'normal', timer: null});
  const noteVelocityForAdaptive = useStableCallback(stableCallbacks, (velocityDpS: number) => {
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
        store.set('renderMode', 'fast');
      }
    } else if (speed <= ADAPTIVE_EXIT_DP_S && state.mode === 'fast' && state.timer == null) {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.mode = 'normal';
        store.set('renderMode', 'normal');
      }, ADAPTIVE_EXIT_DELAY_MS);
    }
  });
  const clearAdaptiveTimer = useStableCallback(stableCallbacks, () => {
    if (adaptiveStateRef.current.timer != null) {
      clearTimeout(adaptiveStateRef.current.timer);
    }
  });
  useEffect(() => clearAdaptiveTimer, [clearAdaptiveTimer]);
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
  const prewarmAdmissionRef = useRef<{
    target: AdmissionRange;
    focus: AdmissionRange;
    admitted: AdmissionRange | null;
    direction: 1 | -1;
    version: number;
    rafId: number | null;
    waiters: Array<() => void>;
  } | null>(null);
  const prewarmFocusRef = useRef<{focus: AdmissionRange; direction: 1 | -1} | null>(null);
  const cancelPrewarmAdmission = useStableCallback(stableCallbacks, () => {
    const admission = prewarmAdmissionRef.current;
    if (admission == null) return;
    if (admission.rafId != null) cancelAnimationFrame(admission.rafId);
    admission.rafId = null;
    prewarmAdmissionRef.current = null;
    flushWaiters(admission.waiters);
  });
  const cancelFlingPrewarm = useStableCallback(stableCallbacks, () => {
    cancelPrewarmAdmission();
    const admission = flingAdmissionRef.current;
    if (admission != null) {
      if (admission.rafId != null) cancelAnimationFrame(admission.rafId);
      flingAdmissionRef.current = null;
    }
  });
  useEffect(() => cancelFlingPrewarm, [cancelFlingPrewarm]);

  const pendingSizesRef = useRef<{
    buffer: Float64Array<ArrayBuffer>;
    count: number;
    rafId: number | null;
  }>(null as unknown as {buffer: Float64Array<ArrayBuffer>; count: number; rafId: number | null});
  pendingSizesRef.current ??= {buffer: nativeFloat64Array(32 * 2), count: 0, rafId: null};
  const cellBridgeRef = useRef<CellBridge>({
    awaitingLayout: 0,
    cells: new Set(),
    onLayoutSettled: () => {},
    onAutoFixedMismatch: () => {},
  });
  const layoutSettleWaitersRef = useRef<Array<() => void>>([]);
  const commitWaitersRef = useRef<Array<() => void>>([]);
  const notifyLayoutSettled = useStableCallback(stableCallbacks, () => {
    flushWaiters(layoutSettleWaitersRef.current);
  });
  commitBindings.push(() => {
    cellBridgeRef.current.onLayoutSettled = notifyLayoutSettled;
  });

  const measurementCtxRef = useRef<{
    items: ReadonlyArray<T>;
    getItemType?: (item: T, index: number) => ItemTypeKey;
    itemsAreEqual?: (prev: T, next: T, index: number) => boolean;
    estimatedItemSize: number;
  }>({items, getItemType, itemsAreEqual, estimatedItemSize});
  commitBindings.push(() => {
    measurementCtxRef.current = {items, getItemType, itemsAreEqual, estimatedItemSize};
  });
  const estimateDriftStatsRef = useRef<Map<string, EstimateDriftStats> | null>(null);
  const onItemSizeChangedRef = useRef(onItemSizeChanged);
  commitBindings.push(() => {
    onItemSizeChangedRef.current = onItemSizeChanged;
  });

  const refillLayoutCacheRef = useRef<() => void>(() => {});

  const measurementApiCtxRef = useRef<MeasurementCtx<T> | null>(null);
  if (measurementApiCtxRef.current == null) {
    measurementApiCtxRef.current = {} as MeasurementCtx<T>;
  }
  const measurementApiRef = useRef<MeasurementApi | null>(null);
  if (measurementApiRef.current == null) {
    measurementApiRef.current = createMeasurement(measurementApiCtxRef.current);
  }
  const measurement = measurementApiRef.current;
  const flushPendingItemSizes = measurement.flush;
  const enqueueItemSize = measurement.enqueue;
  useEffect(() => measurement.cancelPending, [measurement]);
  const rearmMountedCells = useStableCallback(
    stableCallbacks,
    (from: number) => {
      const ctx = measurementCtxRef.current;
      const revision = measurementApiCtxRef.current!.revision;
      for (const record of cellBridgeRef.current.cells) {
        const identity = record.identity;
        if (identity == null || identity.index < from || record.raw < 0) continue;
        if (
          record.measures &&
          isCurrentMeasurement(
            identity,
            ctx.items,
            revision,
            ctx.itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined,
          )
        ) {
          resupplyCellSize(record, enqueueItemSize);
        } else {
          record.rearm = true;
        }
      }
    },
  );


  const autoFixedEnabled = autoFixedItemSizes === true && getItemType != null && cacheEnabled;
  const autoFixedEnabledRef = useRef(autoFixedEnabled);
  commitBindings.push(() => {
    autoFixedEnabledRef.current = autoFixedEnabled;
  });
  const autoFixedTypesRef = useRef<ReadonlyMap<ItemTypeKey, number>>(new Map());
  const resolveFixedSize = useStableCallback(
    stableCallbacks,
    (item: T, index: number, type: ItemTypeKey | undefined): number | undefined => {
      const explicit = getFixedItemSize?.(item, index, type);
      if (explicit != null) return explicit + mainAxisGap;
      if (type === undefined) return undefined;
      return autoFixedTypesRef.current.get(type);
    },
  );
  const lastFixedPushRef = useRef<{
    items: ReadonlyArray<T>;
    hasFixedItemSize: boolean;
    hasItemType: boolean;
    autoFixed: ReadonlyMap<ItemTypeKey, number>;
    mainAxisGap: number;
  } | null>(null);
  const pushFixedItemSizes = useStableCallback(stableCallbacks, (full: boolean = false) => {
    if (itemCount === 0 || hybridRef.current == null) return;
    const autoFixed = autoFixedTypesRef.current;
    if (getFixedItemSize == null && autoFixed.size === 0) {
      lastFixedPushRef.current = null;
      return;
    }
    const last = lastFixedPushRef.current;
    const from =
      !full &&
      NitroListDevFlags.dataAppendFastPath &&
      last != null &&
      last.hasFixedItemSize === hasFixedItemSize &&
      last.hasItemType === hasItemType &&
      last.mainAxisGap === mainAxisGap &&
      last.autoFixed === autoFixed
        ? firstDifferingIndex(last.items, items)
        : 0;
    for (let i = from; i < itemCount; i++) {
      const item = items[i];
      const size = resolveFixedSize(item, i, getItemType?.(item, i));
      if (size != null && Number.isFinite(size) && size >= 0) {
        enqueueItemSize(i, size);
      }
    }
    if (NITRO_LIST_PERF_COMPILED) {
      NitroListPerfMonitor.recordUserCallbacks(
        (itemCount - from) * ((getItemType != null ? 1 : 0) + (getFixedItemSize != null ? 1 : 0)),
      );
    }
    lastFixedPushRef.current = {items, hasFixedItemSize, hasItemType, autoFixed, mainAxisGap};
    flushPendingItemSizes();
  });
  const pushFixedItemSizesRef = useRef(pushFixedItemSizes);
  commitBindings.push(() => {
    pushFixedItemSizesRef.current = pushFixedItemSizes;
    if (lastFixedPushRef.current != null && lastFixedPushRef.current.items !== items) {
      lastFixedPushRef.current = null;
    }
  });
  const commitAutoFixedTypes = useStableCallback(
    stableCallbacks,
    (next: Map<ItemTypeKey, number>, pushSizes: boolean) => {
      autoFixedTypesRef.current = next;
      store.set('autoFixedTypes', next.size > 0 ? next : null);
      if (pushSizes) {
        queueMicrotask(() => pushFixedItemSizesRef.current());
      }
    },
  );
  const freezeAutoFixedTypesRef = useRef<
    (candidates: Set<ItemTypeKey>, widthDp: number, fontScale: number) => void
  >(() => {});
  commitBindings.push(() => {
    freezeAutoFixedTypesRef.current = (candidates, widthDp, fontScale) => {
      let next: Map<ItemTypeKey, number> | null = null;
      for (const type of candidates) {
        const size = getCachedFixedSize(measurementCacheKey(type, widthDp, fontScale, measurementCacheDomain));
        if (size == null) continue;
        if (next == null) next = new Map(autoFixedTypesRef.current);
        next.set(type, size);
      }
      if (next != null) commitAutoFixedTypes(next, true);
    };
  });
  const handleAutoFixedMismatch = useStableCallback(
    stableCallbacks,
    (index: number, sizeDp: number, identity?: MeasurementIdentity) => {
      const ctx = measurementCtxRef.current;
      if (
        identity != null &&
        !isCurrentMeasurement(
          identity,
          ctx.items,
          measurementApiCtxRef.current!.revision,
          ctx.itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined,
        )
      )
        return;
      const item = ctx.items[index];
      if (item !== undefined && ctx.getItemType != null) {
        const type = ctx.getItemType(item, index);
        const widthDp = measurementApiCtxRef.current!.cacheWidth();
        if (widthDp > 0) {
          markMeasurementVariable(
            measurementCacheKey(type, widthDp, PixelRatio.getFontScale(), measurementApiCtxRef.current!.measurementCacheDomain),
            sizeDp,
          );
        }
        if (autoFixedTypesRef.current.has(type)) {
          const next = new Map(autoFixedTypesRef.current);
          next.delete(type);
          commitAutoFixedTypes(next, false);
        }
      }
      enqueueItemSize(index, sizeDp, identity);
    },
  );
  commitBindings.push(() => {
    cellBridgeRef.current.onAutoFixedMismatch = handleAutoFixedMismatch;
  });
  const previousCacheDomainRef = useRef(measurementCacheDomain);
  useEffect(() => {
    if (previousCacheDomainRef.current === measurementCacheDomain && autoFixedEnabled) return;
    previousCacheDomainRef.current = measurementCacheDomain;
    if (autoFixedTypesRef.current.size === 0) return;
    commitAutoFixedTypes(new Map(), false);
    measurement.cancelPending();
    dataChangeCtxRef.current!.commitData(null, true, -1);
    invalidateLayoutCache();
    refillLayoutCacheRef.current();
    rearmMountedCells(0);
  }, [measurementCacheDomain, autoFixedEnabled, commitAutoFixedTypes, measurement, invalidateLayoutCache,
    rearmMountedCells]);


  const readTotalSizeRef = useRef(readTotalSize);
  commitBindings.push(() => {
    readTotalSizeRef.current = readTotalSize;
  });

  const lastScrollOffsetRef = useRef(initialTargetRef.current?.offset ?? 0);
  const scrollDriverKey = experimentalUiThreadScroll === true ? 'ui-driver' : 'js-driver';
  const committedScrollDriverKeyRef = useRef(scrollDriverKey);
  commitBindings.push(() => {
    committedScrollDriverKeyRef.current = scrollDriverKey;
  });
  const scrollMountOffset = useMemo<{x: number; y: number} | undefined>(() => {
    const offset =
      committedScrollDriverKeyRef.current !== scrollDriverKey
        ? lastScrollOffsetRef.current
        : (initialTargetRef.current?.offset ?? 0);
    if (offset <= 0) return undefined;
    return isHorizontal ? {x: offset, y: 0} : {x: 0, y: offset};
  }, [isHorizontal, scrollDriverKey]);
  const viewportSizeRef = useRef<{width: number; height: number}>({width: 0, height: 0});
  const mainViewportRef = useRef(0);
  const crossViewportRef = useRef(0);
  const cacheWidth = () => Math.max(0,
    (crossViewportRef.current - crossPadding.start - crossPadding.end) / resolvedColumns - crossAxisGap,
  );

  commitBindings.push(() => {
    Object.assign(measurementApiCtxRef.current!, {
      revision: measurementRevision,
      dataRevisionRef: nativeDataRevisionRef,
      layout,
      consumeSnapshot: (slab, written, commitRange) => rangePipeline.consumeSnapshot(slab, written, commitRange),
      measurementCacheDomain,
      cacheWidth,
      cacheEnabled,
      pendingSizesRef,
      engineRef: hybridRef,
      mvcpStateRef,
      mvcpResolvedRef,
      isPrewarmingRangeRef,
      measurementCtxRef,
      crossViewportRef,
      columnsRef,
      autoFixedEnabledRef,
      autoFixedTypesRef,
      estimateDriftStatsRef,
      freezeAutoFixedTypesRef,
      onItemSizeChangedRef,
      anchoredEndSpaceRef,
      updateEndSpaceRef,
      refillLayoutCacheRef,
      applyMvcpCorrectionRef,
      invalidateLayoutCache,
      readItemOffset,
    } satisfies MeasurementCtx<T>);
  });
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
  commitBindings.push(() => {
    maintainAtEndRef.current = maintainScrollAtEnd
      ? {
          threshold:
            typeof maintainScrollAtEnd === 'object' && maintainScrollAtEnd.threshold != null
              ? maintainScrollAtEnd.threshold
              : 0.1,
          animated: typeof maintainScrollAtEnd === 'object' && maintainScrollAtEnd.animated === true,
        }
      : null;
  });
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
  const cancelPendingStickToEnd = useStableCallback(stableCallbacks, () => {
    const stick = stickToEndRef.current;
    stick.wasAtEnd = false;
    stick.pending = false;
    stick.regrow = false;
  });
  const scheduleStickToEnd = useStableCallback(stableCallbacks, (animated: boolean) => {
    const stick = stickToEndRef.current;
    stick.pending = true;
    requestAnimationFrame(() => {
      const current = stickToEndRef.current;
      const activity = scrollActivityRef.current;
      if (hybridRef.current == null || !current.wasAtEnd || activity.dragging || activity.momentum) {
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
  });

  const itemCountRef = useRef(itemCount);
  commitBindings.push(() => {
    itemCountRef.current = itemCount;
  });

  const edgeCtxRef = useRef<EdgeCallbacksCtx | null>(null);
  if (edgeCtxRef.current == null) {
    edgeCtxRef.current = {} as EdgeCallbacksCtx;
  }
  commitBindings.push(() => {
    Object.assign(edgeCtxRef.current!, {
      onEndReached,
      onStartReached,
      onEndReachedThreshold,
      onStartReachedThreshold,
      footerSize,
      paddingEnd,
      suppressEdgeRearmRef,
      anchoredEndSpaceRef,
      maintainAtEndRef,
      itemCountRef,
      mainViewportRef,
      effectivePaddingStartRef,
      endSpaceRef,
      lastScrollOffsetRef,
      stickToEndRef,
      scrollActivityRef,
      endEdgeStateRef,
      startEdgeStateRef,
      readTotalSize,
      scheduleStickToEnd,
    } satisfies EdgeCallbacksCtx);
  });
  const checkEdgeCallbacksImplRef = useRef<(() => void) | null>(null);
  if (checkEdgeCallbacksImplRef.current == null) {
    checkEdgeCallbacksImplRef.current = createEdgeCallbacks(edgeCtxRef.current);
  }
  const checkEdgeCallbacks = checkEdgeCallbacksImplRef.current;

  const checkEdgeCallbacksRef = useRef(checkEdgeCallbacks);
  useEffect(() => {
    checkEdgeCallbacksRef.current = checkEdgeCallbacks;
    checkEdgeCallbacks();
  }, [
    checkEdgeCallbacks,
    onEndReached,
    onStartReached,
    onEndReachedThreshold,
    onStartReachedThreshold,
    itemCount,
    footerSize,
    paddingEnd,
  ]);

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
  const itemTypesCtxRef = useRef<ItemTypesCtx<T> | null>(null);
  if (itemTypesCtxRef.current == null) {
    itemTypesCtxRef.current = {} as ItemTypesCtx<T>;
  }
  commitBindings.push(() => {
    Object.assign(itemTypesCtxRef.current!, {
      measurementCacheDomain,
      cacheWidth,
      cacheEnabled,
      items,
      analysis: dataAnalysis,
      itemCount,
      getItemType,
      columnLayout,
      engineRef: hybridRef,
      typeIdMapRef,
      crossViewportRef,
      columnsRef,
      autoFixedEnabledRef,
      autoFixedTypesRef,
      commitAutoFixedTypes,
    } satisfies ItemTypesCtx<T>);
  });
  const itemTypesApiRef = useRef<ItemTypesApi | null>(null);
  if (itemTypesApiRef.current == null) {
    itemTypesApiRef.current = createItemTypes(itemTypesCtxRef.current);
  }
  const itemTypes = itemTypesApiRef.current;

  const seedTypeMeansFromCache = itemTypes.seedTypeMeans;


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
  const resolveScrollCommand = useStableCallback(stableCallbacks, (commandId: number) => {
    const resolver = pendingScrollResolversRef.current.get(commandId);
    if (resolver != null) {
      pendingScrollResolversRef.current.delete(commandId);
      resolver();
    }
  });
  const beginScrollCommand = useStableCallback(stableCallbacks, () => {
    const pending = pendingScrollResolversRef.current;
    if (pending.size > 0) {
      const resolvers = Array.from(pending.values());
      pending.clear();
      for (const resolve of resolvers) resolve();
    }
    return ++scrollCommandIdRef.current;
  });
  const trackScrollCommand = useStableCallback(stableCallbacks, (commandId: number) => {
    return new Promise<void>((resolve) => {
      if (commandId !== scrollCommandIdRef.current) {
        resolve();
        return;
      }
      pendingScrollResolversRef.current.set(commandId, resolve);
    });
  });
  const resolvePendingScrollCommands = useStableCallback(stableCallbacks, () => {
    const pending = pendingScrollResolversRef.current;
    const resolvers = Array.from(pending.values());
    pending.clear();
    for (const resolve of resolvers) resolve();
  });
  useEffect(() => resolvePendingScrollCommands, [resolvePendingScrollCommands]);
  const dataJustChangedRef = useRef(false);
  const awaitScrollReadiness = useStableCallback(stableCallbacks, async (commandId: number) => {
    if (!dataJustChangedRef.current) return;
    dataJustChangedRef.current = false;
    const deadline = Date.now() + SCROLL_READINESS_TIMEOUT_MS;
    let stableFrames = 0;
    let lastVersion = lastSeenLayoutVersionRef.current;
    while (stableFrames < SCROLL_READINESS_STABLE_FRAMES && Date.now() < deadline) {
      await waitForNextFrame();
      if (commandId !== scrollCommandIdRef.current || hybridRef.current == null) return;
      const version = lastSeenLayoutVersionRef.current;
      if (version === lastVersion) {
        stableFrames++;
      } else {
        stableFrames = 0;
        lastVersion = version;
      }
    }
  });
  const estimateFreezeDepthRef = useRef(0);
  const acquireEstimateFreeze = useStableCallback(stableCallbacks, () => {
    if (++estimateFreezeDepthRef.current === 1 && hybridRef.current) {
      hybridRef.current.setEstimatesFrozen(true);
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    }
  });
  const isEngineAttached = useStableCallback(stableCallbacks, () => hybridRef.current != null);
  const releaseEstimateFreeze = useStableCallback(stableCallbacks, () => {
    if (
      estimateFreezeDepthRef.current > 0 &&
      --estimateFreezeDepthRef.current === 0 &&
      hybridRef.current
    ) {
      hybridRef.current.setEstimatesFrozen(false);
      // The range notification may arrive later; synchronous landing reads
      // must already see the means applied by the thaw.
      invalidateLayoutCache();
      if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
    }
  });
  const lastPrewarmRangeRef = useRef<{
    start: number;
    end: number;
    layoutVersion: number;
  } | null>(null);

  const attachEngine = useStableCallback(
    stableCallbacks,
    (value: NitroListEngine | null) => {
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
      if (estimateFreezeDepthRef.current > 0) {
        value.setEstimatesFrozen(true);
        if (NITRO_LIST_PERF_COMPILED) NitroListPerfMonitor.recordJsiCall();
      }
      flushPendingItemSizes();
      evaluateViewabilityRef.current();
    },
  );
  const attachEngineRef = useRef(attachEngine);
  commitBindings.push(() => {
    attachEngineRef.current = attachEngine;
  });

  const [attachedHybrid, setAttachedHybrid] = useState<NitroListEngine | null>(null);
  const uiThreadDriverActive =
    experimentalUiThreadScroll === true && attachedHybrid != null;
  const uiThreadDriverActiveRef = useRef(uiThreadDriverActive);
  commitBindings.push(() => {
    uiThreadDriverActiveRef.current = uiThreadDriverActive;
  });

  const uiPaddingTopSv = useSharedValue(0);
  useEffect(() => {
    uiPaddingTopSv.value = effectivePaddingStart;
  }, [effectivePaddingStart, uiPaddingTopSv]);
  const uiScrollOffsetSv = useSharedValue(
    (initialTargetRef.current?.offset ?? 0) - paddingStart,
  );
  useEffect(() => {
    lastJsStickyTyRef.current = null;
    lastJsStickyIndexRef.current = null;
  }, [uiThreadDriverActive, stickyIndices]);

  const rangeStateRef = useRef<{start: number; end: number; layoutVersion: number}>({
    start: 0,
    end: -1,
    layoutVersion: 0,
  });
  const committedRangeRef = useRef<RangeState>({start: 0, end: -1, layoutVersion: 0});
  const prewarmStateRef = useRef<{start: number; end: number; layoutVersion: number} | null>(
    null,
  );
  const commitCounterRef = useRef(0);
  const pendingCommitRef = useRef(0);
  const setRangeTracked = useStableCallback(
    stableCallbacks,
    (next: {start: number; end: number; layoutVersion: number}) => {
      const current = rangeStateRef.current;
      if (
        current.start === next.start &&
        current.end === next.end &&
        current.layoutVersion === next.layoutVersion
      ) {
        return;
      }
      rangeStateRef.current = next;
      pendingCommitRef.current = commitCounterRef.current + 1;
      store.set('range', next);
    },
  );
  const setPrewarmRangeTracked = useStableCallback(
    stableCallbacks,
    (next: {start: number; end: number; layoutVersion: number} | null) => {
      const current = prewarmStateRef.current;
      if (current === next) return;
      if (
        current != null &&
        next != null &&
        current.start === next.start &&
        current.end === next.end &&
        current.layoutVersion === next.layoutVersion
      ) {
        return;
      }
      prewarmStateRef.current = next;
      pendingCommitRef.current = commitCounterRef.current + 1;
      store.set('prewarmRange', next);
    },
  );


  const refillLayoutCache = layout.refillIfCold;
  commitBindings.push(() => {
    refillLayoutCacheRef.current = refillLayoutCache;
  });


  const lastSeenLayoutVersionRef = useRef<number>(-1);
  const captureMvcpAnchorRef = useRef<(engineOffset: number) => void>(() => {});
  const emitFirstVisibleRef = useRef<() => void>(() => {});
  const lastFirstVisibleIndexRef = useRef(-1);
  const onFirstVisibleItemChangedRef = useRef(onFirstVisibleItemChanged);
  useEffect(() => {
    onFirstVisibleItemChangedRef.current = onFirstVisibleItemChanged;
  });
  const lastPushedEngineOffsetRef = useRef<number | null>(null);
  const pendingScrollCommandRef = useRef<NitroListScrollCommandEcho | null>(null);
  const mvcpAnchorHintRef = useRef(0);
  const mvcpAnchorKeySourceRef = useRef<object | null>(null);
  const lastLiveEngineOffsetRef = useRef(lastScrollOffsetRef.current);

  const rangeCtxRef = useRef<RangePipelineCtx | null>(null);
  if (rangeCtxRef.current == null) {
    rangeCtxRef.current = {} as RangePipelineCtx;
  }
  commitBindings.push(() => {
    Object.assign(rangeCtxRef.current!, {
      store,
      dataRevisionRef: nativeDataRevisionRef,
      layout,
      engineRef: hybridRef,
      itemCountRef,
      latestRangeRef,
      lastPrewarmRangeRef,
      lastSeenLayoutVersionRef,
      lastPushedEngineOffsetRef,
      lastLiveEngineOffsetRef,
      isPrewarmingRangeRef,
      uiThreadDriverActiveRef,
      prewarmFocusRef,
      prewarmAdmissionRef,
      prewarmStateRef,
      pendingCommitRef,
      scrollActivityRef,
      programmaticAnimatedScrollSeenRef,
      effectivePaddingStartRef,
      lastScrollOffsetRef,
      mainViewportRef,
      mountTimestampRef,
      layoutSettleWaitersRef,
      commitWaitersRef,
      commitCounterRef,
      pendingSizesRef,
      cellBridgeRef,
      checkEdgeCallbacksRef,
      captureMvcpAnchorRef,
      evaluateViewabilityRef,
      emitFirstVisibleRef,
      readTotalSizeRef,
      readItemOffset,
      readItemSize,
      readTotalSize,
      invalidateLayoutCache,
      fillSlab,
      writeSlabToCache,
      setRangeTracked,
      setPrewarmRangeTracked,
      cancelPrewarmAdmission,
      flushPendingItemSizes,
    } satisfies RangePipelineCtx);
  });
  const rangePipelineRef = useRef<RangePipelineApi | null>(null);
  if (rangePipelineRef.current == null) {
    rangePipelineRef.current = createRangePipeline(rangeCtxRef.current);
  }
  const rangePipeline = rangePipelineRef.current;
  const handleRangeChange = rangePipeline.handleRangeChange;
  const applyScrollOffsetSync = rangePipeline.applyScrollOffsetSync;
  const waitForLayoutSettle = rangePipeline.waitForLayoutSettle;


  const onChangeStickyIndexRef = useRef(onChangeStickyIndex);
  useEffect(() => {
    onChangeStickyIndexRef.current = onChangeStickyIndex;
  });
  const applyStickyIndex = useStableCallback(stableCallbacks, (index: number) => {
    if (stickyIndexRef.current === index) return;
    stickyIndexRef.current = index;
    store.set('stickyIndex', index);
    onChangeStickyIndexRef.current?.(index);
  });

  const scheduleStickyRecomputeOnUi = useStableCallback(stableCallbacks, () => {
    const hybrid = attachedHybrid;
    if (hybrid == null || stickyIndices.length === 0) return;
    const indices = stickyIndices;
    const bar = stickyOffset;
    const offsetSv = uiScrollOffsetSv;
    const translateYSv = stickyTranslateYSv;
    const activeIndexSv = uiStickyIndexSv;
    const overlaySizeSv = stickyOverlaySizeSv;
    const notify = applyStickyIndex;
    scheduleOnUI(() => {
      'worklet';
      driveStickyOnUi(
        hybrid,
        offsetSv.value,
        indices,
        bar,
        translateYSv,
        activeIndexSv,
        overlaySizeSv,
        notify,
      );
    });
  });

  const updateSticky = useStableCallback(
    stableCallbacks,
    (offset: number) => {
      if (stickyIndices.length === 0 || !hybridRef.current) {
        if (lastJsStickyIndexRef.current !== -1) {
          lastJsStickyIndexRef.current = -1;
          uiStickyIndexSv.value = -1;
        }
        applyStickyIndex(-1);
        return;
      }
      lastJsStickyIndexRef.current = null;
      if (uiThreadDriverActiveRef.current) {
        scheduleStickyRecomputeOnUi();
        return;
      }
      const result = computeSticky(
        offset,
        stickyIndices,
        stickyOffset,
        stickyLayoutReader,
        stickyOverlaySizeRef.current,
        stickyResultRef.current,
      );
      applyStickyIndex(result.index);
      if (lastJsStickyTyRef.current !== result.translateY) {
        lastJsStickyTyRef.current = result.translateY;
        stickyTranslateYSv.value = result.translateY;
      }
    },
  );

  const updateStickyRef = useRef(updateSticky);
  commitBindings.push(() => {
    updateStickyRef.current = updateSticky;
  });

  const applyStickyOverlaySize = useStableCallback(
    stableCallbacks,
    (size: number) => {
      if (!(size > 0)) return;
      if (Math.abs(stickyOverlaySizeRef.current - size) <= MEASUREMENT_NOISE_EPSILON_DP) return;
      stickyOverlaySizeRef.current = size;
      stickyOverlaySizeSv.value = size;
      updateStickyRef.current(lastScrollOffsetRef.current - effectivePaddingStartRef.current);
    },
  );

  const handleStickyOverlayLayout = useStableCallback(
    stableCallbacks,
    (e: LayoutChangeEvent) => {
      if (stickySize != null) return;
      const layout = e.nativeEvent.layout;
      applyStickyOverlaySize(isHorizontalRef.current ? layout.width : layout.height);
    },
  );

  useEffect(() => {
    if (stickySize == null) return;
    applyStickyOverlaySize(stickySize);
  }, [stickySize, applyStickyOverlaySize]);

  const viewabilityCtxRef = useRef<ViewabilityCtx<T> | null>(null);
  if (viewabilityCtxRef.current == null) {
    viewabilityCtxRef.current = {} as ViewabilityCtx<T>;
  }
  commitBindings.push(() => {
    Object.assign(viewabilityCtxRef.current!, {
      items,
      keyExtractor,
      config: viewabilityConfig,
      onViewableItemsChanged,
      hasEngine: () => hybridRef.current != null,
      viewableRef: viewableMapRef,
      pendingRef: pendingMapRef,
      scratchRef: viewabilityScratchRef,
      lastEvalRef: lastViewabilityEvalRef,
      committedRangeRef,
      timerRef: viewabilityTimerRef,
      hasInteractedRef,
      mainViewportRef,
      lastScrollOffsetRef,
      effectivePaddingStartRef,
      readItemOffset,
      readItemSize,
      ensureLayout,
      reschedule: () => evaluateViewabilityRef.current(),
    } satisfies ViewabilityCtx<T>);
  });
  const evaluateViewabilityImplRef = useRef<(() => void) | null>(null);
  if (evaluateViewabilityImplRef.current == null) {
    evaluateViewabilityImplRef.current = createViewability(viewabilityCtxRef.current);
  }
  const evaluateViewability = evaluateViewabilityImplRef.current;


  const nativeDataRevisionRef = useRef(0);
  const nativeMeasurementRevisionRef = useRef<typeof measurementRevision | null>(null);
  const fixedDataBufferRef = useRef<Float64Array<ArrayBuffer> | null>(null);
  fixedDataBufferRef.current ??= nativeFloat64Array(128);
  const reportedMemoryCountRef = useRef(0);
  const sentColumnLayoutRef = useRef<typeof columnLayout>(null);
  const carriedIndicesRef = useRef<Set<number>>(new Set());
  const firstUncarriedChange = (from: number, last: number, previous?: ReadonlyArray<T>): number => {
    if (from < 0 || from >= itemCount) return -1;
    const carried = carriedIndicesRef.current;
    carried.clear();
    for (const record of cellBridgeRef.current.cells) {
      const identity = record.identity;
      if (identity == null || !record.measures || record.rearm || record.raw < 0) continue;
      if (identity.index < from || identity.index > last) continue;
      if (
        isCurrentMeasurement(
          identity,
          items,
          measurementRevision,
          itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined,
        )
      ) {
        carried.add(identity.index);
      }
    }
    let index = from;
    while (
      index <= last &&
      (carried.has(index) || (previous != null && index < previous.length && previous[index] === items[index]))
    ) {
      index++;
    }
    carried.clear();
    return index <= last ? index : -1;
  };
  const dataConfigBufferRef = useRef<Float64Array<ArrayBuffer> | null>(null);
  dataConfigBufferRef.current ??= nativeFloat64Array(DATA_CONFIG_LENGTH);
  const commitNativeData = (
    remap: KeyRemapPairs | null,
    reset: boolean,
    invalidateFrom: number,
    previous?: ReadonlyArray<T>,
  ): void => {
    const engine = engineRef.current;
    if (engine == null) return;
    const domainChanged = nativeMeasurementRevisionRef.current !== measurementRevision;
    if (domainChanged) {
      reset = true;
      itemTypes.forgetSent();
      if (nativeMeasurementRevisionRef.current != null) {
        commitAutoFixedTypes(new Map(), false);
      }
    }
    nativeMeasurementRevisionRef.current = measurementRevision;
    if (reset) itemTypes.forgetSeeds();
    const prepared = itemTypes.prepareTypes();
    if (fixedDataBufferRef.current!.length > Math.max(128, itemCount * 8)) {
      fixedDataBufferRef.current = nativeFloat64Array(Math.max(128, itemCount * 2));
    }
    let fixedData = fixedDataBufferRef.current!;
    let fixedCount = 0;
    const fixedFrom = reset ? 0 : invalidateFrom < 0 ? itemCount : invalidateFrom;
    if (!reset && remap == null && pendingSizesRef.current.count === 0) {
      invalidateFrom = firstUncarriedChange(
        invalidateFrom,
        Math.min(dataAnalysis.lastChanged, itemCount - 1),
        previous,
      );
    }
    if (getFixedItemSize != null || autoFixedTypesRef.current.size > 0) {
      for (let i = fixedFrom; i < itemCount; ++i) {
        const size = resolveFixedSize(items[i], i, getItemType?.(items[i], i));
        if (size == null || !Number.isFinite(size) || size < 0) continue;
        fixedData = growNativeFloat64Array(fixedData, (fixedCount + 1) * 2);
        fixedData[fixedCount * 2] = i;
        fixedData[fixedCount * 2 + 1] = size;
        ++fixedCount;
      }
    }
    const carryFrom = reset || remap != null ? 0 : invalidateFrom;
    if (carryFrom >= 0) {
      const cellBridge = cellBridgeRef.current;
      for (const record of cellBridge.cells) {
        const identity = record.identity;
        if (identity == null || !record.measures || record.raw < 0 || identity.index < carryFrom) continue;
        if (
          !isCurrentMeasurement(
            identity,
            items,
            measurementRevision,
            itemsAreEqual as ((prev: unknown, next: unknown, index: number) => boolean) | undefined,
          )
        ) {
          record.rearm = true;
          continue;
        }
        fixedData = growNativeFloat64Array(fixedData, (fixedCount + 1) * 2);
        fixedData[fixedCount * 2] = identity.index;
        fixedData[fixedCount * 2 + 1] = record.raw + record.gap;
        ++fixedCount;
        markCellSupplied(record, cellBridge);
      }
    }
    fixedDataBufferRef.current = fixedData;
    const config = dataConfigBufferRef.current!;
    const spansPending = columnLayout != null && (reset || columnLayout !== sentColumnLayoutRef.current);
    if (
      !reset &&
      remap == null &&
      invalidateFrom < 0 &&
      prepared.count === 0 &&
      fixedCount === 0 &&
      !spansPending &&
      config[1] === itemCount &&
      config[2] === estimatedItemSize &&
      config[3] === effectiveDrawDistance &&
      config[4] === Number(isHorizontal) &&
      config[5] === resolvedColumns &&
      config[6] === MEASUREMENT_EPSILON_DP
    ) {
      return;
    }
    sentColumnLayoutRef.current = columnLayout;
    invalidateLayoutCache();
    writeDataConfig(config, {count: itemCount, estimate: estimatedItemSize,
      draw: effectiveDrawDistance, horizontal: isHorizontal, columns: resolvedColumns,
      epsilon: MEASUREMENT_EPSILON_DP, reset, revision: ++nativeDataRevisionRef.current,
      invalidateFrom, typeStart: prepared.start, typeCount: prepared.count, typeOffset: prepared.offset,
      fixedCount, remapCount: remap?.mappedCount ?? 0,
      spanCount: !spansPending ? 0 : itemCount - (reset ? 0 : columnLayout.changedFrom),
      spanStart: reset || !spansPending ? 0 : columnLayout.changedFrom});
    engine.updateData(config.buffer, prepared.types.buffer,
      (columnLayout?.spans.buffer as ArrayBuffer | undefined) ?? emptyNativeBuffer(),
      fixedData.buffer, (remap?.pairs.buffer as ArrayBuffer | undefined) ?? emptyNativeBuffer());
    const reportedCount = reportedMemoryCountRef.current;
    if (
      itemCount >= Math.max(ENGINE_MEMORY_REPORT_MIN_ITEMS, reportedCount * 2) ||
      (reportedCount >= ENGINE_MEMORY_REPORT_MIN_ITEMS && itemCount * 4 <= reportedCount)
    ) {
      reportedMemoryCountRef.current = itemCount;
      reportEngineMemory(engine);
    }
  };

  const previousItemsRef = useRef<ReadonlyArray<T>>(items);
  const previousDataVersionRef = useRef<unknown>(dataVersion);
  const dataChangeCtxRef = useRef<DataChangeCtx<T> | null>(null);
  if (dataChangeCtxRef.current == null) {
    dataChangeCtxRef.current = {} as DataChangeCtx<T>;
  }
  commitBindings.push(() => {
    Object.assign(dataChangeCtxRef.current!, {
      items,
      dataVersion,
      keyExtractor,
      previousItemsRef,
      commitData: commitNativeData,
      analysis: dataAnalysis,
      itemsAreEqual,
      previousDataVersionRef,
      dataJustChangedRef,
      engineRef: hybridRef,
      mvcpStateRef,
      mvcpResolvedRef,
      applyMvcpCorrectionRef,
      viewableRef: viewableMapRef,
      pendingRef: pendingMapRef,
      isPrewarmingRangeRef,
      lastPrewarmRangeRef,
      lastViewabilityEvalRef,
      viewabilityTimerRef,
      cancelFlingPrewarm,
      setPrewarmRangeTracked,
      invalidateLayoutCache,
      readItemOffset,
      evaluateViewability,
    } satisfies DataChangeCtx<T>);
  });
  const onDataMaybeChangedRef = useRef<(() => void) | null>(null);
  if (onDataMaybeChangedRef.current == null) {
    onDataMaybeChangedRef.current = createDataChangeHandler(dataChangeCtxRef.current);
  }
  const onDataMaybeChanged = onDataMaybeChangedRef.current;
  useEffect(() => {
    evaluateViewabilityRef.current = evaluateViewability;
    evaluateViewability();
  }, [
    evaluateViewability,
    onDataMaybeChanged,
    items,
    dataVersion,
    keyExtractor,
    viewabilityConfig,
    viewabilityConfig?.minimumViewTime,
    viewabilityConfig?.waitForInteraction,
    viewabilityConfig?.itemVisiblePercentThreshold,
    viewabilityConfig?.viewAreaCoveragePercentThreshold,
    onViewableItemsChanged,
  ]);


  useEffect(() => {
    if (!IS_DEV || itemCount === 0) return;
    return watchZeroViewport(mainViewportRef, itemCount);
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

  const clearViewabilityTimer = useStableCallback(stableCallbacks, () => {
    if (viewabilityTimerRef.current != null) {
      clearTimeout(viewabilityTimerRef.current);
      viewabilityTimerRef.current = null;
    }
  });
  useEffect(() => clearViewabilityTimer, [clearViewabilityTimer]);

  const captureMvcpAnchor = useStableCallback(
    stableCallbacks,
    (engineOffset: number) => {
      const mvcp = mvcpStateRef.current;
      if (!mvcp.enabled) return;
      const shouldRestore = mvcpShouldRestoreRef.current;
      const r = latestRangeRef.current;
      const low = Math.max(0, r.start);
      const high = r.end;
      let anchorIndex = -1;
      if (shouldRestore == null) {
        if (high >= low) {
          let i = mvcpAnchorHintRef.current;
          if (i < low) i = low;
          else if (i > high) i = high;
          if (readItemOffset(i) >= engineOffset) {
            while (i > low && readItemOffset(i - 1) >= engineOffset) i--;
            anchorIndex = i;
          } else {
            do {
              i++;
            } while (i <= high && readItemOffset(i) < engineOffset);
            anchorIndex = i <= high ? i : high;
          }
        }
      } else {
        for (let i = low; i <= high; i++) {
          if (readItemOffset(i) >= engineOffset && isMvcpAnchorEligible(items, shouldRestore, i)) {
            anchorIndex = i;
            break;
          }
        }
        if (anchorIndex < 0) {
          for (let i = high; i >= low; i--) {
            if (isMvcpAnchorEligible(items, shouldRestore, i)) {
              anchorIndex = i;
              break;
            }
          }
        }
      }
      if (anchorIndex < 0) {
        mvcp.anchor = null;
        return;
      }
      mvcpAnchorHintRef.current = anchorIndex;
      const offset = readItemOffset(anchorIndex);
      const anchor = mvcp.anchor;
      if (anchor != null && anchor.index === anchorIndex && mvcpAnchorKeySourceRef.current === dataAnalysis) {
        anchor.offset = offset;
        return;
      }
      const anchorItem = items[anchorIndex];
      const key = keyExtractor && anchorItem !== undefined ? keyExtractor(anchorItem, anchorIndex) : null;
      mvcpAnchorKeySourceRef.current = dataAnalysis;
      if (anchor != null) {
        anchor.index = anchorIndex;
        anchor.key = key;
        anchor.offset = offset;
      } else {
        mvcp.anchor = {index: anchorIndex, key, offset};
      }
    },
  );
  useEffect(() => {
    captureMvcpAnchorRef.current = captureMvcpAnchor;
  }, [captureMvcpAnchor]);

  const scrollHandlersCtxRef = useRef<ScrollHandlersCtx | null>(null);
  if (scrollHandlersCtxRef.current == null) {
    scrollHandlersCtxRef.current = {} as ScrollHandlersCtx;
  }
  const scrollHandlersApiRef = useRef<ScrollHandlersApi | null>(null);
  if (scrollHandlersApiRef.current == null) {
    scrollHandlersApiRef.current = createScrollHandlers(scrollHandlersCtxRef.current);
  }
  const scrollHandlers = scrollHandlersApiRef.current;
  const settleScrollPosition = scrollHandlers.settleScrollPosition;
  const settleProgrammaticAnimatedScroll = scrollHandlers.settleProgrammaticAnimatedScroll;
  const flushPendingMvcpAdjust = scrollHandlers.flushPendingMvcpAdjust;
  const handleOuterScroll = scrollHandlers.handleOuterScroll;
  const handleOuterLayout = scrollHandlers.handleOuterLayout;
  const handleScrollBeginDrag = scrollHandlers.handleScrollBeginDrag;
  const handleScrollEndDrag = scrollHandlers.handleScrollEndDrag;
  const handleMomentumScrollBegin = scrollHandlers.handleMomentumScrollBegin;
  const handleMomentumScrollEnd = scrollHandlers.handleMomentumScrollEnd;


  const userOnScrollRef = useRef(userOnScroll);
  useEffect(() => {
    userOnScrollRef.current = userOnScroll;
  });

  const uiThreadScrollHandler = useAnimatedScrollHandler<UiScrollContext>(
    createUiScrollHandlers({
      isHorizontal,
      engine: attachedHybrid,
      paddingTopSv: uiPaddingTopSv,
      scrollOffsetSv: uiScrollOffsetSv,
      userScrollOffsetSv: scrollOffsetSharedValue,
      stickyIndices,
      stickyOffset,
      stickyTranslateYSv,
      stickyIndexSv: uiStickyIndexSv,
      stickyOverlaySizeSv,
      applyStickyIndex,
      hasViewabilityWakeups: onViewableItemsChanged != null && viewabilityConfig != null,
      settleViewabilityTick: scrollHandlers.settleUiViewabilityTick,
      onScrollWorklet,
      hasUserOnScroll: userOnScroll != null,
      emitUserScroll: scrollHandlers.emitUserScrollFromUi,
      settleEndDrag: scrollHandlers.settleUiEndDrag,
    }),
  );

  const contentInsetBottomRef = useRef(0);

  const [snapOffsets, setSnapOffsets] = useState<number[] | undefined>(undefined);
  const snapIndicesKey = snapToIndices != null ? snapToIndices.join(',') : '';

  const geometryCtxRef = useRef<GeometryCtx | null>(null);
  if (geometryCtxRef.current == null) {
    geometryCtxRef.current = {} as GeometryCtx;
  }
  commitBindings.push(() => {
    Object.assign(geometryCtxRef.current!, {
      itemCount,
      footerSize,
      paddingStart,
      paddingEnd,
      headerSize,
      alignItemsAtEnd: alignItemsAtEnd === true,
      snapToIndices,
      store,
      engineRef: hybridRef,
      mainViewportRef,
      effectivePaddingStartRef,
      endSpaceRef,
      contentInsetBottomRef,
      anchoredEndSpaceRef,
      anchoredReadyRef,
      readTotalSize,
      readItemOffset,
      readItemSize,
      ensureLayout,
      setAlignPad,
      setSnapOffsets,
    } satisfies GeometryCtx);
  });
  const geometryApiRef = useRef<GeometryApi | null>(null);
  if (geometryApiRef.current == null) {
    geometryApiRef.current = createGeometry(geometryCtxRef.current);
  }
  const geometry = geometryApiRef.current;
  const getMaxScrollOffset = geometry.getMaxScrollOffset;

  const clampScrollOffset = geometry.clampScrollOffset;

  const indexAtOffset = geometry.indexAtOffset;

  const emitFirstVisible = useStableCallback(stableCallbacks, () => {
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
  });
  useEffect(() => {
    emitFirstVisibleRef.current = emitFirstVisible;
    emitFirstVisible();
  }, [emitFirstVisible, items, itemCount, keyExtractor, indexAtOffset]);

  const updateAlignPad = geometry.updateAlignPad;
  commitBindings.push(() => {
    updateAlignPadRef.current = updateAlignPad;
  });
  useEffect(() => {
    updateAlignPad();
  }, [
    updateAlignPad,
    itemCount,
    alignItemsAtEnd,
    paddingStart,
    headerSize,
    footerSize,
    paddingEnd,
  ]);

  const updateEndSpace = geometry.updateEndSpace;
  commitBindings.push(() => {
    updateEndSpaceRef.current = updateEndSpace;
  });
  useEffect(() => {
    updateEndSpace();
  }, [updateEndSpace, items, anchoredEndSpace, itemCount, footerSize, paddingEnd]);

  const recomputeSnapOffsets = geometry.recomputeSnapOffsets;
  const recomputeSnapOffsetsRef = useRef(recomputeSnapOffsets);
  commitBindings.push(() => {
    recomputeSnapOffsetsRef.current = recomputeSnapOffsets;
  });
  useEffect(() => {
    recomputeSnapOffsets();
  }, [recomputeSnapOffsets, snapIndicesKey, snapToIndices, itemCount, effectivePaddingStart]);

  const handleHeaderLayout = useStableCallback(stableCallbacks, (e: LayoutChangeEvent) => {
    const layout = e.nativeEvent.layout;
    const size = isHorizontalRef.current ? layout.width : layout.height;
    setHeaderSize((prev) => (Math.abs(prev - size) > MEASUREMENT_NOISE_EPSILON_DP ? size : prev));
  });
  const handleFooterLayout = useStableCallback(stableCallbacks, (e: LayoutChangeEvent) => {
    const layout = e.nativeEvent.layout;
    const size = isHorizontalRef.current ? layout.width : layout.height;
    setFooterSize((prev) => (Math.abs(prev - size) > MEASUREMENT_NOISE_EPSILON_DP ? size : prev));
  });
  useEffect(() => {
    if (ListHeaderComponent == null) setHeaderSize(0);
  }, [ListHeaderComponent]);
  useEffect(() => {
    if (ListFooterComponent == null) setFooterSize(0);
  }, [ListFooterComponent]);

  const prewarmAnimatedDestination = useStableCallback(
    stableCallbacks,
    (destEngineOffset: number) => {
      const viewportH = mainViewportRef.current;
      if (itemCount === 0 || viewportH <= 0) return;
      const margin = effectiveDrawDistanceRef.current;
      let start = indexAtOffset(Math.max(0, destEngineOffset - margin));
      let end = Math.max(start, indexAtOffset(destEngineOffset + viewportH + margin));
      const current = prewarmStateRef.current;
      if (current != null && current.end >= current.start) {
        start = Math.min(start, current.start);
        end = Math.max(end, current.end);
      }
      setPrewarmRangeTracked({start, end, layoutVersion: lastSeenLayoutVersionRef.current});
    },
  );

  const scrollToAbsoluteOffset = useStableCallback(
    stableCallbacks,
    (offset: number, animated: boolean) => {
      if (!uiThreadDriverActiveRef.current && pendingSizesRef.current.count > 0) {
        flushPendingItemSizes(false);
      }
      const target = clampScrollOffset(offset);
      const engineOffset = target - effectivePaddingStartRef.current;
      const commandFrom = lastScrollOffsetRef.current;
      const velocitySample = scrollVelocityRef.current;
      velocitySample.velocity = 0;
      velocitySample.time = 0;
      resetVelocityRing(velocityRingRef.current);
      hybridRef.current?.resetScrollVelocity();
      if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
      if (animated) {
        endProgrammaticAnimatedScroll();
        prewarmAnimatedDestination(engineOffset);
        const activity = scrollActivityRef.current;
        activity.programmaticAnimated = true;
        programmaticAnimatedScrollSeenRef.current = false;
        programmaticAnimatedTimerRef.current = setTimeout(() => {
          programmaticAnimatedTimerRef.current = null;
          if (!activity.programmaticAnimated) return;
          activity.programmaticAnimated = false;
          settleProgrammaticAnimatedScroll(
            programmaticAnimatedScrollSeenRef.current ? lastScrollOffsetRef.current : target,
          );
          if (!isPrewarmingRangeRef.current) setPrewarmRangeTracked(null);
          flushPendingMvcpAdjust();
          resolveAnimatedScrollCommand();
        }, PROGRAMMATIC_ANIMATED_SETTLE_FALLBACK_MS);
      } else {
        endProgrammaticAnimatedScroll();
        settleScrollPosition(target, engineOffset);
        pendingScrollCommandRef.current = noteScrollCommand(
          pendingScrollCommandRef.current,
          commandFrom,
          target,
          Date.now(),
          SCROLL_COMMAND_ECHO_MAX_AGE_MS,
        );
      }
      scrollToNativeOffset(scrollRef.current, target, isHorizontalRef.current, animated);
      return target;
    },
  );


  const applyMvcpCorrection = useStableCallback(stableCallbacks, (diff: number) => {
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
    store.set('mvcpAdjust', store.get('mvcpAdjust') + executable);
  });
  useEffect(() => {
    applyMvcpCorrectionRef.current = applyMvcpCorrection;
  }, [applyMvcpCorrection]);

  const prewarmFlingDestination = useStableCallback(stableCallbacks, () => {
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
      setPrewarmRangeTracked({
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
  });

  const recordFlingOutcome = useStableCallback(stableCallbacks, (finalAbsoluteY: number) => {
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
  });
  useEffect(() => {
    prewarmFlingDestinationRef.current = prewarmFlingDestination;
    recordFlingOutcomeRef.current = recordFlingOutcome;
  }, [prewarmFlingDestination, recordFlingOutcome]);

  const resetScrollVelocity = useStableCallback(stableCallbacks, () => {
    hybridRef.current?.resetScrollVelocity();
    if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
  });
  const measuredConstraintsRef = useRef({cross: 0, fontScale: PixelRatio.getFontScale()});
  const setEngineViewport = useStableCallback(stableCallbacks, (width: number, height: number) => {
    const cross = isHorizontalRef.current ? height : width;
    const fontScale = PixelRatio.getFontScale();
    const previous = measuredConstraintsRef.current;
    if (previous.cross > 0 && (previous.cross !== cross || previous.fontScale !== fontScale)) {
      const revision = measurementApiCtxRef.current!.revision;
      revision.geometry++;
      measurement.cancelPending();
      commitAutoFixedTypes(new Map(), false);
      dataChangeCtxRef.current!.commitData(null, true, -1);
      invalidateLayoutCache();
      setMeasurementGeometry(value => value + 1);
    }
    measuredConstraintsRef.current = {cross, fontScale};
    hybridRef.current?.setViewport(width, height);
    if (NITRO_LIST_PERF_COMPILED && hybridRef.current) NitroListPerfMonitor.recordJsiCall();
  });

  commitBindings.push(() => {
    Object.assign(scrollHandlersCtxRef.current!, {
      userOnScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      scrollOffsetSharedValue,
      uiScrollOffsetSv,
      applyMvcpCorrectionRef,
      captureMvcpAnchorRef,
      checkEdgeCallbacksRef,
      crossViewportRef,
      effectivePaddingStartRef,
      emitFirstVisibleRef,
      evaluateViewabilityRef,
      hasInteractedRef,
      isHorizontalRef,
      isPrewarmingRangeRef,
      lastPrewarmRangeRef,
      lastPushedEngineOffsetRef,
      lastScrollOffsetRef,
      lastViewabilityEvalRef,
      latestRangeRef,
      mainViewportRef,
      mvcpStateRef,
      pendingScrollCommandRef,
      pendingSizesRef,
      prewarmFlingDestinationRef,
      programmaticAnimatedScrollSeenRef,
      recordFlingOutcomeRef,
      scrollActivityRef,
      scrollVelocityRef,
      suppressEdgeRearmRef,
      uiThreadDriverActiveRef,
      updateAlignPadRef,
      updateEndSpaceRef,
      velocityRingRef,
      viewportSizeRef,
      mountTimestampRef,
      applyScrollOffsetSync,
      beginScrollCommand,
      cancelFlingPrewarm,
      cancelPendingStickToEnd,
      captureMvcpAnchor,
      endProgrammaticAnimatedScroll,
      flushPendingItemSizes,
      getMaxScrollOffset,
      noteVelocityForAdaptive,
      readItemOffset,
      readItemSize,
      readTotalSize,
      resetScrollVelocity,
      seedTypeMeansFromCache,
      setPrewarmRangeTracked,
      setEngineViewport,
      updateSticky,
      userOnScrollRef,
    } satisfies ScrollHandlersCtx);
  });


  const stiCtxRef = useRef<ScrollToIndexCtx | null>(null);
  if (stiCtxRef.current == null) {
    stiCtxRef.current = {} as ScrollToIndexCtx;
  }
  commitBindings.push(() => {
    Object.assign(stiCtxRef.current!, {
      itemCount,
      footerSize,
      paddingEnd,
      scrollCommandIdRef,
      lastScrollOffsetRef,
      lastPrewarmRangeRef,
      isPrewarmingRangeRef,
      prewarmFocusRef,
      mainViewportRef,
      effectivePaddingStartRef,
      effectiveDrawDistanceRef,
      lastSeenLayoutVersionRef,
      endSpaceRef,
      contentInsetBottomRef,
      animatedScrollResolverRef,
      beginScrollCommand,
      resolveScrollCommand,
      trackScrollCommand,
      awaitScrollReadiness,
      waitForLayoutSettle,
      indexAtOffset,
      clampScrollOffset,
      getMaxScrollOffset,
      readItemOffset,
      readItemSize,
      ensureLayout,
      applyScrollOffsetSync,
      resetScrollVelocity,
      scrollToAbsoluteOffset,
      setRangeTracked,
      setPrewarmRangeTracked,
      cancelFlingPrewarm,
      cancelPrewarmAdmission,
      acquireEstimateFreeze,
      releaseEstimateFreeze,
      isEngineAttached,
    } satisfies ScrollToIndexCtx);
  });
  const stiRef = useRef<ScrollToIndexApi | null>(null);
  if (stiRef.current == null) {
    stiRef.current = createScrollToIndex(stiCtxRef.current);
  }
  const sti = stiRef.current;

  const computeIndexScrollOffset = sti.computeIndexScrollOffset;
  const scrollToIndexPrecisely = sti.precisely;
  const scrollToEndPrecisely = sti.toEnd;
  useEffect(() => {
    scrollToEndForMaintainRef.current = scrollToEndPrecisely;
  }, [scrollToEndPrecisely]);


  const initialRevealCtxRef = useRef<InitialRevealCtx | null>(null);
  if (initialRevealCtxRef.current == null) {
    initialRevealCtxRef.current = {} as InitialRevealCtx;
  }
  commitBindings.push(() => {
    Object.assign(initialRevealCtxRef.current!, {
      itemCount,
      initialTargetRef,
      committedRangeRef,
      scrollCommandIdRef,
      lastScrollOffsetRef,
      effectivePaddingStartRef,
      mainViewportRef,
      getMaxScrollOffset,
      computeIndexScrollOffset,
      clampScrollOffset,
      scrollToAbsoluteOffset,
      scrollToIndexPrecisely,
      scrollToEndPrecisely,
      indexAtOffset,
      setRevealPending: setInitialRevealPending,
    } satisfies InitialRevealCtx);
  });
  const initialRevealApiRef = useRef<InitialRevealApi | null>(null);
  if (initialRevealApiRef.current == null) {
    initialRevealApiRef.current = createInitialReveal(initialRevealCtxRef.current);
  }
  const initialReveal = initialRevealApiRef.current;
  const initialPassRef = useRef<() => {diff: number; visKey: string} | null>(initialReveal.pass);
  commitBindings.push(() => {
    initialPassRef.current = initialReveal.pass;
  });

  useEffect(() => {
    if (!initialRevealPending) return;
    return scheduleRevealTimeout(setInitialRevealPending);
  }, [initialRevealPending]);

  const settleInitialTarget = initialReveal.settle;
  const settleInitialTargetRef = useRef(settleInitialTarget);
  commitBindings.push(() => {
    settleInitialTargetRef.current = settleInitialTarget;
  });
  useEffect(() => {
    settleInitialTarget();
  }, [settleInitialTarget, itemCount, scrollToIndexPrecisely, scrollToEndPrecisely]);


  const syncOffsetAfterLayout = useStableCallback(stableCallbacks, () => {
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
  });
  const syncOffsetAfterLayoutRef = useRef(syncOffsetAfterLayout);
  commitBindings.push(() => {
    syncOffsetAfterLayoutRef.current = syncOffsetAfterLayout;
  });
  useEffect(() => {
    syncOffsetAfterLayout();
  }, [syncOffsetAfterLayout, stickyIndices, stickyOffset, attachedHybrid, effectivePaddingStart]);

  const bumpCommitCounter = useStableCallback(stableCallbacks, () => {
    commitCounterRef.current++;
    flushWaiters(commitWaitersRef.current);
  });

  const fireOnLoadIfReady = useStableCallback(stableCallbacks, () => {
    if (hasFiredOnLoadRef.current) return;
    const committed = committedRangeRef.current;
    if (committed.end < committed.start) return;
    hasFiredOnLoadRef.current = true;
    onLoad?.({elapsedTimeInMs: Date.now() - mountTimestampRef.current});
  });
  const fireOnLoadIfReadyRef = useRef(fireOnLoadIfReady);
  commitBindings.push(() => {
    fireOnLoadIfReadyRef.current = fireOnLoadIfReady;
  });
  useEffect(() => {
    fireOnLoadIfReady();
  }, [fireOnLoadIfReady, onLoad]);

  const drawDistanceExpandedStateRef = useRef(drawDistanceExpanded);
  commitBindings.push(() => {
    drawDistanceExpandedStateRef.current = drawDistanceExpanded;
  });
  const expandDrawDistanceRafRef = useRef<number | null>(null);
  const maybeExpandDrawDistance = useStableCallback(stableCallbacks, () => {
    if (drawDistanceExpandedStateRef.current || expandDrawDistanceRafRef.current != null) return;
    const committed = committedRangeRef.current;
    if (committed.end < committed.start) return;
    expandDrawDistanceRafRef.current = requestAnimationFrame(() => {
      expandDrawDistanceRafRef.current = null;
      setDrawDistanceExpanded(true);
    });
  });
  const maybeExpandDrawDistanceRef = useRef(maybeExpandDrawDistance);
  commitBindings.push(() => {
    maybeExpandDrawDistanceRef.current = maybeExpandDrawDistance;
  });
  const cancelDrawDistanceExpansion = useStableCallback(stableCallbacks, () => {
    if (expandDrawDistanceRafRef.current != null) {
      cancelAnimationFrame(expandDrawDistanceRafRef.current);
      expandDrawDistanceRafRef.current = null;
    }
  });
  useEffect(() => {
    maybeExpandDrawDistance();
    return cancelDrawDistanceExpansion;
  }, [maybeExpandDrawDistance, cancelDrawDistanceExpansion]);

  const lastCommittedLayoutVersionRef = useRef(-1);
  const handleCellsCommit = useStableCallback(
    stableCallbacks,
    (range: RangeState, _prewarmRange: RangeState | null, phase: 'layout' | 'passive') => {
      const layoutWaiter = NitroListDevFlags.stiLayoutEffectWaiter;
      if (phase === 'layout') {
        if (layoutWaiter) bumpCommitCounter();
        return;
      }
      committedRangeRef.current = range;
      evaluateViewabilityRef.current();
      const versionChanged = range.layoutVersion !== lastCommittedLayoutVersionRef.current;
      lastCommittedLayoutVersionRef.current = range.layoutVersion;
      if (versionChanged) {
        updateAlignPadRef.current();
        updateEndSpaceRef.current();
        recomputeSnapOffsetsRef.current();
      }
      settleInitialTargetRef.current();
      if (versionChanged) syncOffsetAfterLayoutRef.current();
      if (!layoutWaiter) bumpCommitCounter();
      fireOnLoadIfReadyRef.current();
      maybeExpandDrawDistanceRef.current();
    },
  );

  const scrollIndexIntoViewImpl = useStableCallback(
    stableCallbacks,
    (index: number, animated: boolean, viewOffset: number): Promise<void> => {
      if (index < 0 || index >= itemCount) return Promise.resolve();
      const viewportMain = mainViewportRef.current;
      ensureLayout(index);
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
  );

  const handleCtxRef = useRef<HandleCtx<T> | null>(null);
  if (handleCtxRef.current == null) {
    handleCtxRef.current = {} as HandleCtx<T>;
  }
  commitBindings.push(() => {
    Object.assign(handleCtxRef.current!, {
      columnLayout,
      resolvedColumns,
      crossPadding,
      mainAxisGap,
      items,
      itemCount,
      keyExtractor,
      effectivePaddingStart,
      engineRef: hybridRef,
      scrollRef,
      typeIdMapRef,
      viewportSizeRef,
      crossViewportRef,
      isHorizontalRef,
      lastScrollOffsetRef,
      contentInsetBottomRef,
      isPrewarmingRangeRef,
      lastPrewarmRangeRef,
      animatedScrollResolverRef,
      checkEdgeCallbacksRef,
      readItemOffset,
      readItemSize,
      ensureLayout,
      readTotalSize,
      beginScrollCommand,
      trackScrollCommand,
      resolveScrollCommand,
      cancelFlingPrewarm,
      setPrewarmRangeTracked,
      scrollToAbsoluteOffset,
      scrollToIndexPrecisely,
      scrollToEndPrecisely,
      scrollIndexIntoViewImpl,
    } satisfies HandleCtx<T>);
  });
  const imperativeHandleRef = useRef<NitroListHandle | null>(null);
  if (imperativeHandleRef.current == null) {
    imperativeHandleRef.current = createNitroListHandle(handleCtxRef.current);
  }
  useImperativeHandle(ref, () => imperativeHandleRef.current as NitroListHandle, []);

  const alwaysRenderKeysJoined = alwaysRender?.keys != null ? alwaysRender.keys.join('\0') : '';
  const alwaysRenderKeyIndices = useMemo<number[] | null>(() => {
    const keys = alwaysRender?.keys;
    if (keys == null || keys.length === 0 || keyExtractor == null) return null;
    const wanted = new Set(keys);
    const found: number[] = [];
    for (let i = 0; i < items.length && found.length < wanted.size; i++) {
      if (wanted.has(keyExtractor(items[i], i))) found.push(i);
    }
    return found;
  }, [alwaysRenderKeysJoined, items, dataVersion, hasKeyExtractor]);

  const attachedRangeCallbackRef = useRef<typeof handleRangeChange | null>(null);
  useLayoutEffect(() => {
    let engine = engineRef.current;
    const first = engine == null;
    if (engine == null) {
      engine = createNitroListEngine();
      engineRef.current = engine;
      reportedMemoryCountRef.current = 0;
      nativeMeasurementRevisionRef.current = null;
      itemTypes.forgetSent();
    }
    // The data handler remaps old sources before a shrinking count is applied.
    onDataMaybeChanged();
    if (first) {
      attachEngineRef.current(engine);
      rearmMountedCells(0);
    }
    itemTypes.seedTypeMeans();
  }, [items, dataVersion, measurementRevision, itemCount, estimatedItemSize,
    effectiveDrawDistance, isHorizontal, resolvedColumns, columnLayout,
    onDataMaybeChanged, itemTypes, rearmMountedCells]);
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (engine == null || attachedRangeCallbackRef.current === handleRangeChange) return;
    attachedRangeCallbackRef.current = handleRangeChange;
    engine.onRangeChange = handleRangeChange;
  }, [handleRangeChange]);
  const detachEngine = useStableCallback(stableCallbacks, () => {
    const engine = engineRef.current;
    engineRef.current = null;
    attachedRangeCallbackRef.current = null;
    attachEngineRef.current(null);
    if (engine != null) {
      engine.onRangeChange = undefined;
      engine.dispose();
    }
  });
  useLayoutEffect(() => detachEngine, [detachEngine]);

  const anchoredEndSpaceAnchor =
    anchoredEndSpace != null ? Math.trunc(anchoredEndSpace.anchorIndex) : null;

  return (
    <View
      style={[
        orchestratorStyles.wrapper,
        style,
        initialRevealPending ? orchestratorStyles.hiddenUntilReveal : null,
      ]}>
      {React.cloneElement(resolvedRenderScrollComponent({
        ref: scrollRef,
        horizontal: isHorizontal,
        snapToOffsets: snapOffsets,
        onScroll: experimentalUiThreadScroll === true ? uiThreadScrollHandler : handleOuterScroll,
        onScrollBeginDrag: handleScrollBeginDrag,
        onScrollEndDrag: handleScrollEndDrag,
        onMomentumScrollBegin: handleMomentumScrollBegin,
        onMomentumScrollEnd: handleMomentumScrollEnd,
        onLayout: handleOuterLayout,
        scrollEventThrottle:
          experimentalUiThreadScroll === true || NitroListDevFlags.jsScrollEventThrottle1 ? 1 : 16,
        contentContainerStyle,
        contentOffset: scrollMountOffset,
        maintainVisibleContentPosition: mvcpEnabled ? MVCP_SCROLL_VIEW_CONFIG : undefined,
        children: (
          <>
            {mvcpEnabled ? (
              <MvcpAdjustAnchorSlot store={store} horizontal={isHorizontal} />
            ) : null}
            {alignPad > 0 ? (
              <View style={isHorizontal ? {width: alignPad} : {height: alignPad}} />
            ) : null}
            {ListHeaderComponent != null ? (
              <View onLayout={handleHeaderLayout}>{renderSlot(ListHeaderComponent)}</View>
            ) : null}
            {itemCount === 0 ? renderSlot(ListEmptyComponent) : null}
            <ListContainer store={store} horizontal={isHorizontal}>
              <NitroListCells
                measurementRevision={measurementRevision}
                measurementGeometry={measurementGeometry}
                store={store}
                items={items as ReadonlyArray<unknown>}
                itemCount={itemCount}
                keyExtractor={keyExtractor as NitroListCellsProps['keyExtractor']}
                getItemType={getItemType as NitroListCellsProps['getItemType']}
                getFixedItemSize={getFixedItemSize as NitroListCellsProps['getFixedItemSize']}
                alwaysRender={alwaysRender}
                alwaysRenderKeyIndices={alwaysRenderKeyIndices}
                anchoredEndSpaceAnchor={anchoredEndSpaceAnchor}
                adaptiveRenderMode={adaptiveRenderMode === true}
                hideRelatedCell={hideRelatedCell}
                horizontal={isHorizontal}
                columnLayout={columnLayout}
                resolvedColumns={resolvedColumns}
                mainAxisGap={mainAxisGap}
                crossAxisGap={crossAxisGap}
                renderItem={renderItem as NitroListRenderItem<unknown>}
                ItemSeparatorComponent={
                  ItemSeparatorComponent as React.ComponentType<{leadingItem: unknown}> | undefined
                }
                enqueueItemSize={enqueueItemSize}
                cellBridge={cellBridgeRef.current}
                itemsAreEqual={itemsAreEqual as ItemsAreEqualFn | undefined}
                readItemOffset={readItemOffset}
                ensureLayout={ensureLayout}
                onCommit={handleCellsCommit}
              />
            </ListContainer>
            {ListFooterComponent != null ? (
              <View onLayout={handleFooterLayout}>{renderSlot(ListFooterComponent)}</View>
            ) : null}
            <EndSpaceSpacer store={store} horizontal={isHorizontal} />
          </>
        ),
      }), {key: scrollDriverKey})}
      <StickyHeaderSlot
        store={store}
        items={items as ReadonlyArray<unknown>}
        itemCount={itemCount}
        renderItem={renderItem as NitroListRenderItem<unknown>}
        adaptiveRenderMode={adaptiveRenderMode === true}
        translateY={stickyTranslateYSv}
        horizontal={isHorizontal}
        onLayout={handleStickyOverlayLayout}
      />
    </View>
  );
}

const orchestratorStyles = StyleSheet.create({
  wrapper: {
    flex: 1,
    overflow: 'hidden',
  },
  hiddenUntilReveal: {
    opacity: 0,
  },
});

export const NitroList = forwardRef(NitroListInner) as <T>(
  props: NitroListProps<T> & {ref?: React.Ref<NitroListHandle>},
) => React.ReactElement | null;
