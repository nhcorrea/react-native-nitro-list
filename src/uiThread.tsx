import React from 'react';
import {StyleSheet, type LayoutChangeEvent} from 'react-native';
import Animated, {
  makeMutable,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import {scheduleOnUI} from 'react-native-worklets';

import {styles} from './cells';
import {ListStore, useStoreValue} from './listStore';
import type {
  NitroListRenderItem,
  NitroListRenderScrollComponent,
  NitroListRenderScrollComponentProps,
} from './types';
import {computeSticky, driveStickyOnUi} from './sticky';
import {
  createUiScrollHandlers,
  type UiScrollContext,
  type UiScrollHandlerInputs,
} from './uiScrollHandlers';

export {computeSticky, driveStickyOnUi, scheduleOnUI};

export type UiThreadValues = {
  stickyTranslateY: SharedValue<number>;
  stickyIndex: SharedValue<number>;
  stickyOverlaySize: SharedValue<number>;
  paddingTop: SharedValue<number>;
  scrollOffset: SharedValue<number>;
};

export function createUiThreadValues(initial: {
  stickyTranslateY: number;
  stickyOverlaySize: number;
  scrollOffset: number;
}): UiThreadValues {
  return {
    stickyTranslateY: makeMutable(initial.stickyTranslateY),
    stickyIndex: makeMutable(-1),
    stickyOverlaySize: makeMutable(initial.stickyOverlaySize),
    paddingTop: makeMutable(0),
    scrollOffset: makeMutable(initial.scrollOffset),
  };
}

export const defaultAnimatedRenderScrollComponent: NitroListRenderScrollComponent = ({
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

export function UiThreadScroll({
  render,
  props,
  inputs,
}: {
  render: NitroListRenderScrollComponent;
  props: NitroListRenderScrollComponentProps;
  inputs: UiScrollHandlerInputs;
}) {
  const onScroll = useAnimatedScrollHandler<UiScrollContext>(createUiScrollHandlers(inputs));
  return render({...props, onScroll});
}

export function StickyHeaderSlot({
  store,
  items,
  itemCount,
  renderItem,
  adaptiveRenderMode,
  translateY,
  horizontal,
  onLayout,
}: {
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  renderItem: NitroListRenderItem<unknown>;
  adaptiveRenderMode: boolean;
  translateY: SharedValue<number>;
  horizontal: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const stickyIndex = useStoreValue(store, 'stickyIndex');
  const renderMode = useStoreValue(store, 'renderMode');
  const stickyItem = stickyIndex >= 0 && stickyIndex < itemCount ? items[stickyIndex] : undefined;
  if (stickyItem === undefined) return null;
  return (
    <StickyOverlay translateY={translateY} horizontal={horizontal} onLayout={onLayout}>
      {renderItem({
        item: stickyItem,
        index: stickyIndex,
        target: 'StickyHeader',
        renderMode: adaptiveRenderMode ? renderMode : 'normal',
      })}
    </StickyOverlay>
  );
}


export interface StickyOverlayProps {
  translateY: SharedValue<number>;
  horizontal: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  children: React.ReactNode;
}

export const StickyOverlay = React.memo(function StickyOverlay({
  translateY,
  horizontal,
  onLayout,
  children,
}: StickyOverlayProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: horizontal ? [{translateX: translateY.value}] : [{translateY: translateY.value}],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      collapsable={false}
      onLayout={onLayout}
      style={[horizontal ? styles.stickyOverlayHorizontal : styles.stickyOverlay, animatedStyle]}
    >
      {children}
    </Animated.View>
  );
});

