import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

describe('prepend window', () => {
  let harness: NitroListHarness | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    clearMeasurementCache();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  for (const recycleItems of [false, true]) {
    it(`renders only the anchored items, once each, when rows are prepended (recycleItems ${recycleItems})`, async () => {
      const rendered: string[] = [];
      const renderItem: NitroListRenderItem<string> = ({item}) => {
        rendered.push(item);
        return <View style={{height: 64}} />;
      };
      let data = makeItems(2000);
      harness = renderNitroList({
        data,
        renderItem,
        getFixedItemSize: () => 64,
        estimatedItemSize: 64,
        keyExtractor: itemKey,
        drawDistance: 500,
        recycleItems,
        maintainVisibleContentPosition: true,
      });
      harness.layout(360, 628);
      await harness.settle(50);
      harness.scroll(64000);
      await harness.settle(100);
      const before = harness.renderedIndices().map((index) => data[index]);
      for (let round = 0; round < 3; round++) {
        rendered.length = 0;
        data = [...makeItems(50, 100000 + round * 50), ...data];
        harness.update({data});
        await harness.settle(100);
        const window = new Set(harness.renderedIndices().map((index) => data[index]));
        expect(rendered.every((item) => window.has(item))).toBe(true);
        expect(rendered.length).toBeLessThanOrEqual(window.size);
        expect([...window]).toEqual(expect.arrayContaining(before));
      }
    }, 60000);
  }
});
