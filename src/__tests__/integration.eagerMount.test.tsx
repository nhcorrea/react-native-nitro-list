import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Platform, View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {nativeEagerMountHoldersForTests} from './helpers/mockNitroModules';

const renderItem: NitroListRenderItem<string> = () => <View />;

describe('experimentalEagerMount', () => {
  const originalPlatform = Platform.OS;
  let harness: NitroListHarness | null = null;

  function render(props: {experimentalEagerMount?: boolean}) {
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
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    Platform.OS = originalPlatform;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('holds the native eager mount once the initial window expanded and until unmount', async () => {
    Platform.OS = 'android';
    render({experimentalEagerMount: true});
    expect(nativeEagerMountHoldersForTests()).toBe(0);
    await harness?.settle();
    expect(nativeEagerMountHoldersForTests()).toBe(0);
    harness?.frame();
    expect(nativeEagerMountHoldersForTests()).toBe(1);
    harness?.unmount();
    harness = null;
    expect(nativeEagerMountHoldersForTests()).toBe(0);
  });

  it('stays off by default on Android', async () => {
    Platform.OS = 'android';
    render({});
    await harness?.settle();
    harness?.frame();
    expect(nativeEagerMountHoldersForTests()).toBe(0);
  });

  it('never reaches the native object on iOS', async () => {
    Platform.OS = 'ios';
    render({experimentalEagerMount: true});
    await harness?.settle();
    harness?.frame();
    expect(nativeEagerMountHoldersForTests()).toBe(0);
  });
});
