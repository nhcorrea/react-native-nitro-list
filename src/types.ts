import type React from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleProp,
  ViewStyle,
} from 'react-native';
import type {SharedValue} from 'react-native-reanimated';
import type {ScrollHandlerProcessed} from 'react-native-reanimated';
import type {ReanimatedScrollEvent as ScrollEvent} from 'react-native-reanimated/lib/typescript/hook/commonTypes';


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
  size?: number;
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
  autoFixedItemSizes?: boolean;
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
