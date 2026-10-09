import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Platform, StyleSheet, View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {
  nativeClipCallsForTests,
  nativeClippedViewForTests,
  resetNativeClipForTests,
} from './helpers/mockNitroModules';

const renderItem: NitroListRenderItem<string> = () => <View />;
const ORIGIN_TAG = 4242;

type HostProps = {collapsable?: boolean; style?: unknown};
type FlatStyle = {position?: string; right?: number; bottom?: number} | undefined;

function originTag(view: {props?: HostProps} | null): number | null {
  const style = StyleSheet.flatten(view?.props?.style as never) as FlatStyle;
  const isOrigin =
    view?.props?.collapsable === false &&
    style?.position === 'absolute' &&
    style.right === 0 &&
    style.bottom === 0;
  return isOrigin ? ORIGIN_TAG : null;
}

describe('clipItemsToBounds', () => {
  const originalPlatform = Platform.OS;
  let harness: NitroListHarness | null = null;

  function render(props: {clipItemsToBounds?: boolean; recycleItems?: boolean}) {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      ...props,
    });
    harness.layout(400, 600);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reactNative = jest.requireActual<Record<string, unknown>>('react-native');
    jest.spyOn(reactNative, 'findNodeHandle', 'get').mockReturnValue(originTag);
    clearMeasurementCache();
    resetNativeClipForTests();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    Platform.OS = originalPlatform;
    clearMeasurementCache();
    resetNativeClipForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('clips the cell container once on Android by default', async () => {
    Platform.OS = 'android';
    render({});
    await harness?.settle();
    expect(nativeClippedViewForTests(ORIGIN_TAG)).toBe(true);
    expect(nativeClipCallsForTests()).toEqual([[ORIGIN_TAG, true]]);
  });

  it('clips the cell container when cells are recycled', async () => {
    Platform.OS = 'android';
    render({recycleItems: true});
    await harness?.settle();
    expect(nativeClipCallsForTests()).toEqual([[ORIGIN_TAG, true]]);
  });

  it('leaves the container alone when the prop is off', async () => {
    Platform.OS = 'android';
    render({clipItemsToBounds: false});
    await harness?.settle();
    expect(nativeClipCallsForTests()).toEqual([]);
  });

  it('turns the clip off when the prop changes', async () => {
    Platform.OS = 'android';
    render({});
    await harness?.settle();
    harness?.update({clipItemsToBounds: false});
    await harness?.settle();
    expect(nativeClipCallsForTests()).toEqual([
      [ORIGIN_TAG, true],
      [ORIGIN_TAG, false],
    ]);
    expect(nativeClippedViewForTests(ORIGIN_TAG)).toBe(false);
  });

  it('never reaches the native object on iOS', async () => {
    Platform.OS = 'ios';
    render({});
    await harness?.settle();
    expect(nativeClipCallsForTests()).toEqual([]);
  });
});
