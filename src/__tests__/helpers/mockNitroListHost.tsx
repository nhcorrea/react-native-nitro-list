import React, {useLayoutEffect, useRef} from 'react';
import {View, type StyleProp, type ViewStyle} from 'react-native';

import type {NitroListViewMethods} from '../../NitroListView.nitro';
import {HybridNitroListViewMirror} from './layoutCoreMirror';

type WrappedCallback<T> = T | {f: T};

function unwrap<T>(value: WrappedCallback<T> | undefined | null): T | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'f' in (value as object)) {
    return (value as {f: T}).f;
  }
  return value as T;
}

type MockHostProps = {
  hybridRef?: WrappedCallback<(ref: NitroListViewMethods | null) => void>;
  itemCount: number;
  estimatedItemSize: number;
  drawDistance: number;
  horizontal?: boolean;
  numColumns?: number;
  onRangeChange?: WrappedCallback<
    (start: number, end: number, layoutVersion: number, offset: number) => void
  >;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

const mirrors: HybridNitroListViewMirror[] = [];

export function getLastMirror(): HybridNitroListViewMirror {
  const mirror = mirrors[mirrors.length - 1];
  if (mirror == null) {
    throw new Error('no NitroListView mock has mounted yet');
  }
  return mirror;
}

export function clearMirrorsForTests(): void {
  mirrors.length = 0;
}

export function NitroListView(props: MockHostProps): React.ReactElement {
  const mirrorRef = useRef<HybridNitroListViewMirror | null>(null);
  if (mirrorRef.current == null) {
    mirrorRef.current = new HybridNitroListViewMirror();
    mirrors.push(mirrorRef.current);
  }
  const mirror = mirrorRef.current;

  const {itemCount, estimatedItemSize, drawDistance, horizontal, numColumns} = props;
  const onRangeChange = unwrap(props.onRangeChange);
  useLayoutEffect(() => {
    mirror.applyProps({
      itemCount,
      estimatedItemSize,
      drawDistance,
      horizontal,
      numColumns,
      onRangeChange,
    });
  });

  const attachRef = useRef(unwrap(props.hybridRef));
  attachRef.current = unwrap(props.hybridRef);
  useLayoutEffect(() => {
    attachRef.current?.(mirror as unknown as NitroListViewMethods);
    return () => {
      attachRef.current?.(null);
    };
  }, []);

  return <View testID="mock-nitro-list-view">{props.children}</View>;
}
