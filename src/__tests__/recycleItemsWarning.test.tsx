import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

function scrollThrough(harness: NitroListHarness, distance: number): void {
  harness.layout(400, 600);
  harness.frame();
  harness.measureAllCells(() => 100);
  harness.frame();
  for (let y = 600; y <= distance; y += 600) {
    harness.scroll(y);
    harness.frame();
    harness.measureAllCells(() => 100);
    harness.frame();
  }
}

describe('recycleItems dev warning', () => {
  let harness: NitroListHarness | undefined;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = undefined;
    jest.useRealTimers();
    warn.mockRestore();
    clearWarnDevOnceForTests();
  });

  const warnings = () => warn.mock.calls.filter(call => String(call[0]).includes('recycleItems is not set'));

  it('warns once when a list without recycleItems keeps mounting cells while scrolling', () => {
    harness = renderNitroList({data: makeItems(1000), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey});
    scrollThrough(harness, 30000);
    expect(warnings()).toHaveLength(1);
  });

  it('stays quiet when recycleItems is explicitly false', () => {
    harness = renderNitroList({data: makeItems(1000), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey, recycleItems: false});
    scrollThrough(harness, 30000);
    expect(warnings()).toHaveLength(0);
  });

  it('stays quiet when recycleItems is on', () => {
    harness = renderNitroList({data: makeItems(1000), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey, recycleItems: true});
    scrollThrough(harness, 30000);
    expect(warnings()).toHaveLength(0);
  });

  it('stays quiet on a list too short to mount that many cells', () => {
    harness = renderNitroList({data: makeItems(60), renderItem: () => null, estimatedItemSize: 100, keyExtractor: itemKey});
    scrollThrough(harness, 5400);
    expect(warnings()).toHaveLength(0);
  });
});
