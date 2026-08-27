import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListProps} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('maintainVisibleContentPosition {data, size} config (T34)', () => {
  let harness: NitroListHarness;
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  async function mountWith(
    mvcp: NitroListProps<string>['maintainVisibleContentPosition'],
  ): Promise<void> {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: mvcp,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    harness.scroll(500);
    await harness.settle(50);
  }

  it('defaults to size stability ON and data anchoring OFF (the v2 flip)', async () => {
    await mountWith(undefined);

    harness.measureCell(harness.renderedIndices()[0], 180);
    await harness.settle(50);
    expect(harness.lastScrollTop()).toBeCloseTo(580, 3);

    const scrollBefore = harness.lastScrollTop();
    harness.update({data: [...makeItems(5, 1000), ...makeItems(100)]});
    await harness.settle(50);
    expect(harness.lastScrollTop()).toBe(scrollBefore);
  });

  it('false disables both mechanisms', async () => {
    await mountWith(false);

    harness.measureCell(harness.renderedIndices()[0], 180);
    await harness.settle(50);
    expect(harness.lastScrollTop()).toBe(500);
  });

  it('{data: true, size: false} anchors prepends but not measurements', async () => {
    await mountWith({data: true, size: false});

    harness.measureCell(harness.renderedIndices()[0], 180);
    await harness.settle(50);
    expect(harness.lastScrollTop()).toBe(500);

    const scrollBefore = harness.lastScrollTop();
    harness.update({data: [...makeItems(5, 1000), ...makeItems(100)]});
    await harness.settle(50);
    const prependedExtent = harness.handle.getItemOffset(5);
    expect(harness.lastScrollTop()).toBeCloseTo(scrollBefore + prependedExtent, 3);
  });
});
