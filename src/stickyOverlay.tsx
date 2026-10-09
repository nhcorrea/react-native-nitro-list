import React, {useMemo} from 'react';
import {Animated, type LayoutChangeEvent} from 'react-native';

import {styles} from './cells';
import {ListStore, useStoreValue} from './listStore';
import type {NitroListRenderItem} from './types';

export function NativeStickyHeaderSlot({
  store,
  items,
  itemCount,
  renderItem,
  adaptiveRenderMode,
  scrollValue,
  stickyOffset,
  horizontal,
  onLayout,
}: {
  store: ListStore;
  items: ReadonlyArray<unknown>;
  itemCount: number;
  renderItem: NitroListRenderItem<unknown>;
  adaptiveRenderMode: boolean;
  scrollValue: Animated.Value;
  stickyOffset: number;
  horizontal: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const stickyIndex = useStoreValue(store, 'stickyIndex');
  const renderMode = useStoreValue(store, 'renderMode');
  const push = useStoreValue(store, 'stickyPush');
  const transformStyle = useMemo(() => {
    const value =
      push == null
        ? stickyOffset
        : scrollValue.interpolate({
            inputRange: [push.start, push.end],
            outputRange: [push.from, push.to],
            extrapolate: 'clamp',
          });
    return {transform: horizontal ? [{translateX: value}] : [{translateY: value}]};
  }, [push, scrollValue, stickyOffset, horizontal]);
  const stickyItem = stickyIndex >= 0 && stickyIndex < itemCount ? items[stickyIndex] : undefined;
  if (stickyItem === undefined) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      collapsable={false}
      onLayout={onLayout}
      style={[horizontal ? styles.stickyOverlayHorizontal : styles.stickyOverlay, transformStyle]}
    >
      {renderItem({
        item: stickyItem,
        index: stickyIndex,
        target: 'StickyHeader',
        renderMode: adaptiveRenderMode ? renderMode : 'normal',
      })}
    </Animated.View>
  );
}
