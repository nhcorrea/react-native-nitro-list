import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {Platform, ScrollView, View} from 'react-native';

import {NitroListDevFlags} from '../devFlags';
import {clearMeasurementCache} from '../measurementCache';
import type {NitroListProps} from '../NitroList';
import {SCROLL_RHYTHM_RESTORE, SCROLL_RHYTHM_SLOW_MS} from '../scrollHandlers';
import {itemKey, makeItems, NitroListHarness} from './helpers/harness';
import {nativeScrollThrottleCallsForTests, resetNativeScrollThrottleForTests} from './helpers/mockNitroModules';

const SCROLL_TAG = 42;

describe('scroll event rhythm', () => {
  const originalPlatform = Platform.OS;
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
    resetNativeScrollThrottleForTests();
    Platform.OS = 'android';
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListDevFlags.experimentalSlot02 = false;
    Platform.OS = originalPlatform;
    clearMeasurementCache();
    resetNativeScrollThrottleForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mount(props: Partial<NitroListProps<string>> = {}): Promise<NitroListHarness> {
    const mounted = new NitroListHarness({
      renderScrollComponent: undefined,
      data: makeItems(2000),
      renderItem: () => <View />,
      getFixedItemSize: () => 64,
      estimatedItemSize: 64,
      keyExtractor: itemKey,
      ...props,
    });
    harness = mounted;
    const native = require('react-native') as typeof import('react-native');
    const TestScrollView = React.forwardRef((scrollProps: React.ComponentProps<typeof ScrollView>, ref) =>
      mounted.renderScrollComponent({...scrollProps, ref} as Parameters<typeof mounted.renderScrollComponent>[0]));
    jest.spyOn(native as {ScrollView: unknown}, 'ScrollView', 'get').mockReturnValue(TestScrollView);
    mounted.mount();
    mounted.layout(360, 628);
    await mounted.settle(50);
    return mounted;
  }

  function drag(mounted: NitroListHarness, from: number, velocityDpS: number, durationMs: number, stepMs = 16): number {
    let offset = from;
    for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
      mounted.frame(stepMs);
      offset += (velocityDpS * stepMs) / 1000;
      mounted.scroll(offset);
    }
    return offset;
  }

  it('slows the events down during a slow drag and restores the rhythm on release', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount();
    mounted.beginDrag(0);
    const offset = drag(mounted, 0, 500, 640);
    expect(nativeScrollThrottleCallsForTests()).toEqual([[SCROLL_TAG, SCROLL_RHYTHM_SLOW_MS]]);
    mounted.endDrag(offset);
    expect(nativeScrollThrottleCallsForTests()).toEqual([
      [SCROLL_TAG, SCROLL_RHYTHM_SLOW_MS],
      [SCROLL_TAG, SCROLL_RHYTHM_RESTORE],
    ]);
  });

  it('waits for the touch hold before slowing down', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount();
    mounted.beginDrag(0);
    drag(mounted, 0, 500, 128);
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
  });

  it('restores the rhythm when the finger speeds up and never slows down again in the gesture', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount();
    mounted.beginDrag(0);
    let offset = drag(mounted, 0, 500, 480);
    offset = drag(mounted, offset, 3000, 144, 48);
    expect(nativeScrollThrottleCallsForTests()).toEqual([
      [SCROLL_TAG, SCROLL_RHYTHM_SLOW_MS],
      [SCROLL_TAG, SCROLL_RHYTHM_RESTORE],
    ]);
    offset = drag(mounted, offset, 300, 640);
    mounted.endDrag(offset);
    expect(nativeScrollThrottleCallsForTests()).toHaveLength(2);
    mounted.beginDrag(offset);
    offset = drag(mounted, offset, 300, 640);
    expect(nativeScrollThrottleCallsForTests()).toHaveLength(3);
    mounted.endDrag(offset);
    expect(nativeScrollThrottleCallsForTests()).toHaveLength(4);
  });

  it('keeps the rhythm during a short fling and its momentum', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount();
    mounted.beginDrag(0);
    let offset = drag(mounted, 0, 8000, 48);
    mounted.endDrag(offset);
    mounted.momentumBegin(offset);
    offset = drag(mounted, offset, 400, 640);
    mounted.momentumEnd(offset);
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
  });

  it('preserves the throttle chosen by a custom scroll component', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount({
      renderScrollComponent: (props) => <ScrollView {...props} scrollEventThrottle={8} />,
    });
    mounted.beginDrag(0);
    mounted.endDrag(drag(mounted, 0, 500, 640));
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
  });

  it('restores the rhythm if the app begins listening during a slow drag', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    const mounted = await mount();
    mounted.beginDrag(0);
    const offset = drag(mounted, 0, 500, 640);
    const onScroll = jest.fn();
    mounted.update({onScroll});
    drag(mounted, offset, 500, 48, 48);
    expect(nativeScrollThrottleCallsForTests()).toEqual([
      [SCROLL_TAG, SCROLL_RHYTHM_SLOW_MS],
      [SCROLL_TAG, SCROLL_RHYTHM_RESTORE],
    ]);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it('leaves the rhythm alone without the slot', async () => {
    const mounted = await mount();
    mounted.beginDrag(0);
    const offset = drag(mounted, 0, 500, 640);
    mounted.endDrag(offset);
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
  });

  it('leaves the rhythm alone when the app listens to onScroll or pins a header', async () => {
    NitroListDevFlags.experimentalSlot02 = true;
    let mounted = await mount({onScroll: () => {}});
    mounted.beginDrag(0);
    mounted.endDrag(drag(mounted, 0, 500, 640));
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
    mounted.unmount();
    mounted = await mount({stickyHeaderIndices: [0]});
    mounted.beginDrag(0);
    mounted.endDrag(drag(mounted, 0, 500, 640));
    expect(nativeScrollThrottleCallsForTests()).toEqual([]);
  });
});
