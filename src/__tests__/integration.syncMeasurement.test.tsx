import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

type MeasureLayout = (
  relativeTo: unknown,
  onSuccess: (x: number, y: number, width: number, height: number) => void,
) => void;
const hostMethods = (require('@react-native/jest-preset/jest/MockNativeMethods') as {default: {measureLayout: jest.Mock<MeasureLayout>}})
  .default;

const ROW = 64;

describe('synchronous cell measurement', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    NitroListPerfMonitor.disable();
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
    hostMethods.measureLayout.mockReset();
  });

  it('positions mounted cells with their measured size in the commit that mounts them', () => {
    hostMethods.measureLayout.mockImplementation((_relativeTo, onSuccess) => onSuccess(0, 0, 400, ROW));
    harness = renderNitroList({data: makeItems(1000), renderItem: () => <View />, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, 800);
    expect(harness.mirror.getItemSize(0)).toBe(ROW);

    harness.frame();
    expect(harness.mirror.getItemOffset(10)).toBe(10 * ROW);
    const rendered = harness.renderedIndices();
    expect(rendered[rendered.length - 1]).toBeGreaterThanOrEqual(800 / ROW);
  });

  it('measures a cell whose content changed in the commit that renders the change', () => {
    let height = ROW;
    hostMethods.measureLayout.mockImplementation((_relativeTo, onSuccess) => onSuccess(0, 0, 400, height));
    let data = makeItems(50);
    harness = renderNitroList({data, renderItem: () => <View />, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, 800);
    harness.frame();
    expect(harness.mirror.getItemSize(3)).toBe(ROW);

    height = ROW * 2;
    data = data.slice();
    data[3] = `${data[3]}-grown`;
    harness.update({data, keyExtractor: (_item: string, index: number) => `item-${index}`});
    expect(harness.mirror.getItemSize(3)).toBe(ROW * 2);
  });

  it('falls back to the layout event when the host cannot measure synchronously', async () => {
    harness = renderNitroList({data: makeItems(1000), renderItem: () => <View />, estimatedItemSize: 100, keyExtractor: itemKey});
    harness.layout(400, 800);
    expect(harness.mirror.getItemSize(0)).toBe(100);
    harness.measureAllCells(() => ROW);
    await harness.settle(50);
    expect(harness.mirror.getItemSize(0)).toBe(ROW);
  });
});
