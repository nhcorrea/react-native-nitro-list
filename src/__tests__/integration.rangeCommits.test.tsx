import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';

import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

describe('window commits during a scroll', () => {
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
    it(`commits about one window per item crossed and always covers the viewport (recycleItems ${recycleItems})`, async () => {
      const rowHeight = 64;
      const viewport = 628;
      harness = renderNitroList({
        data: makeItems(2000),
        renderItem: () => <View style={{height: rowHeight}} />,
        getFixedItemSize: () => rowHeight,
        estimatedItemSize: rowHeight,
        keyExtractor: itemKey,
        drawDistance: 500,
        recycleItems,
      });
      harness.layout(360, viewport);
      await harness.settle(50);
      const origin = rowHeight * 100;
      harness.scroll(origin);
      await harness.settle(50);
      let previous = harness.renderedIndices().join(',');
      let commits = 0;
      const step = 16;
      const steps = 64;
      for (let k = 1; k <= steps; k++) {
        const offset = origin + k * step;
        harness.scroll(offset);
        harness.frame();
        const rendered = harness.renderedIndices();
        const key = rendered.join(',');
        if (key !== previous) commits++;
        previous = key;
        expect(rendered[0]).toBeLessThanOrEqual(Math.floor(offset / rowHeight));
        expect(rendered[rendered.length - 1]).toBeGreaterThanOrEqual(
          Math.floor((offset + viewport - 1) / rowHeight),
        );
      }
      const crossed = (steps * step) / rowHeight;
      expect(commits).toBeLessThanOrEqual(crossed + 1);
    }, 60000);
  }
});
