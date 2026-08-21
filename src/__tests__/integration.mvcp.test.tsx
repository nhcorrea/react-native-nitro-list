import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {MVCP_ANCHOR_BASE} from '../mvcp';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

function heightForKey(item: string): number {
  const index = Number(item.slice('item-'.length));
  return 100 + (index % 5) * 10;
}

describe('maintainVisibleContentPosition integration', () => {
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

  function measureRendered(items: string[]): void {
    for (const index of harness.renderedIndices()) {
      harness.measureCell(index, heightForKey(items[index]));
    }
  }

  function mvcpAnchorTop(): number {
    const anchors = harness.renderer.root.findAll(
      (node) => typeof node.props?.top === 'number' && node.props.top >= MVCP_ANCHOR_BASE,
    );
    if (anchors.length === 0) throw new Error('MVCP anchor is not rendered');
    return anchors[0].props.top as number;
  }

  it('prepend keeps the anchored item still: remap + adjust by the prepended extent', async () => {
    const items = makeItems(100);
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    measureRendered(items);
    await harness.settle(50);

    harness.scroll(500);
    measureRendered(items);
    await harness.settle(50);

    const anchorBefore = mvcpAnchorTop();
    const scrollBefore = harness.lastScrollTop();
    const sizeOfOldFirst = harness.handle.getItemSize(0);

    const prepended = [...makeItems(10, 1000), ...items];
    harness.update({data: prepended});
    await harness.settle(50);

    expect(harness.mirror.callLog).toContain('remapItemSizes');
    expect(harness.mirror.callLog).not.toContain('resetItemSizes');
    expect(harness.handle.getItemSize(10)).toBe(sizeOfOldFirst);

    const prependedExtent = harness.handle.getItemOffset(10);
    expect(prependedExtent).toBeGreaterThan(0);
    expect(harness.lastScrollTop()).toBeCloseTo(scrollBefore + prependedExtent, 3);
    expect(mvcpAnchorTop()).toBeCloseTo(anchorBefore + prependedExtent, 3);
  });

  it('re-measure above the anchor shifts scroll by the exact diff', async () => {
    const items = makeItems(100);
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    measureRendered(items);
    await harness.settle(50);

    harness.scroll(300);
    await harness.settle(50);
    const scrollBefore = harness.lastScrollTop();

    harness.measureCell(0, harness.handle.getItemSize(0) + 80);
    await harness.settle(50);

    expect(harness.lastScrollTop()).toBeCloseTo(scrollBefore + 80, 3);
  });

  it('defers corrections while a programmatic animated scroll is in flight (T8)', async () => {
    const items = makeItems(100);
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    measureRendered(items);
    await harness.settle(50);
    harness.scroll(400);
    await harness.settle(50);

    act(() => {
      harness.handle.scrollToOffset({offset: 800, animated: true});
    });
    await harness.settle(20);
    const commandsDuringAnimation = harness.scrollCommands.length;
    const scrollDuring = harness.lastScrollTop();

    const firstRendered = harness.renderedIndices()[0];
    harness.measureCell(firstRendered, harness.handle.getItemSize(firstRendered) + 50);
    harness.frame();
    expect(harness.scrollCommands.length).toBe(commandsDuringAnimation);
    expect(harness.lastScrollTop()).toBe(scrollDuring);

    harness.momentumEnd(800);
    await harness.settle(50);
    expect(harness.lastScrollTop()).toBeCloseTo(800 + 50, 3);
  });

  it('shouldRestorePosition vetoes optimistic anchors so removal-during-prepend still corrects (T24)', async () => {
    const items = makeItems(100);
    const veto = new Set<string>();
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: {
        data: true,
        shouldRestorePosition: (item) => !veto.has(item),
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    measureRendered(items);
    await harness.settle(50);

    harness.scroll(300);
    await harness.settle(50);
    const firstVisible = harness.renderedIndices().find(
      (index) => harness.handle.getItemOffset(index) >= 300,
    ) as number;
    veto.add(items[firstVisible]);
    harness.scroll(301);
    await harness.settle(50);

    const scrollBefore = harness.lastScrollTop();
    const removedSize = harness.handle.getItemSize(firstVisible);
    const next = [...makeItems(5, 2000), ...items.filter((it) => it !== items[firstVisible])];
    harness.update({data: next});
    await harness.settle(50);

    const prependedExtent = harness.handle.getItemOffset(5);
    expect(harness.lastScrollTop()).toBeCloseTo(scrollBefore + prependedExtent - removedSize, 3);
  });

  it('an MVCP correction never reads as fling velocity (T2): no phantom prewarm window', async () => {
    const items = makeItems(300);
    harness = renderNitroList({
      data: items,
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainVisibleContentPosition: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    measureRendered(items);
    await harness.settle(50);
    harness.scroll(1000);
    await harness.settle(50);

    harness.beginDrag(1000);
    harness.scroll(1004);
    harness.frame(16);
    harness.scroll(1008);

    harness.measureCell(harness.renderedIndices()[0], 400);
    harness.frame(0);

    harness.frame(16);
    harness.scroll(1012);
    harness.endDrag(1012);
    await harness.settle(50);

    const indices = harness.renderedIndices();
    const span = indices[indices.length - 1] - indices[0];
    expect(span).toBeLessThan(30);
    expect(indices[0]).toBeGreaterThanOrEqual(0);
  });
});
