import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {NitroListDevFlags} from '../devFlags';
import {clearWarnDevOnceForTests} from '../devWarnings';
import {clearMeasurementCache} from '../measurementCache';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 800;

function countCalls(log: string[], name: string): number {
  let n = 0;
  for (const entry of log) if (entry === name) n++;
  return n;
}

describe('data changes with an identity-preserving prefix (plan 2026-09-01, Fase F)', () => {
  let harness: NitroListHarness | null = null;
  let warnSpy: ReturnType<typeof jest.spyOn>;
  const flagsBefore = {...NitroListDevFlags};

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    Object.assign(NitroListDevFlags, flagsBefore);
    clearMeasurementCache();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  const typeOf = (item: string) => (item.endsWith('0') ? 'round' : 'plain');

  async function mountWithSpies(count: number) {
    const getItemType = jest.fn((item: string) => typeOf(item));
    const getFixedItemSize = jest.fn(() => 64);
    harness = renderNitroList({
      data: makeItems(count),
      renderItem: () => null,
      estimatedItemSize: 80,
      keyExtractor: itemKey,
      getItemType: getItemType as (item: string, index: number) => string,
      getFixedItemSize: getFixedItemSize as () => number,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    return {getItemType, getFixedItemSize};
  }

  it('appending items runs the callbacks only past the old length and pushes a type range', async () => {
    const {getItemType, getFixedItemSize} = await mountWithSpies(300);
    const log = harness!.mirror.callLog;
    const fullPushesBefore = countCalls(log, 'setItemTypes');
    getItemType.mockClear();
    getFixedItemSize.mockClear();

    harness!.update({data: makeItems(305)});
    await harness!.settle(50);

    expect(countCalls(log, 'setItemTypes')).toBe(fullPushesBefore);
    expect(countCalls(log, 'setItemTypesRange')).toBeGreaterThanOrEqual(1);
    const rendered = harness!.renderedIndices().length;
    expect(getItemType.mock.calls.length).toBeLessThan(300);
    expect(getItemType.mock.calls.length).toBeLessThanOrEqual(5 + rendered * 4);
    expect(getFixedItemSize.mock.calls.length).toBeLessThan(300);
    for (let i = 300; i < 305; i++) {
      expect(harness!.mirror.core.getSize(i)).toBe(64);
      expect(harness!.handle.getItemOffset(i)).toBe(i * 64);
    }
    expect(harness!.mirror.core.countUnmeasured(300, 305)).toBe(0);
  });

  it('editing the last item re-runs the callbacks for that item only', async () => {
    const {getItemType, getFixedItemSize} = await mountWithSpies(300);
    const log = harness!.mirror.callLog;
    const fullPushesBefore = countCalls(log, 'setItemTypes');
    getItemType.mockClear();
    getFixedItemSize.mockClear();

    const next = makeItems(300);
    next[299] = 'item-299 (edited)';
    harness!.update({data: next});
    await harness!.settle(50);

    expect(countCalls(log, 'setItemTypes')).toBe(fullPushesBefore);
    const rendered = harness!.renderedIndices().length;
    expect(getItemType.mock.calls.length).toBeLessThanOrEqual(1 + rendered * 4);
    expect(getFixedItemSize.mock.calls.length).toBeLessThanOrEqual(1 + rendered * 4);
    expect(harness!.handle.getTotalSize()).toBe(300 * 64);
  });

  it('remaps when most keys survive and resets when too few do', async () => {
    async function replaceFraction(kept: number) {
      harness?.unmount();
      const total = 100;
      harness = renderNitroList({
        data: makeItems(total),
        renderItem: () => null,
        estimatedItemSize: 80,
        keyExtractor: itemKey,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      await harness.settle(50);
      const log = harness.mirror.callLog;
      log.length = 0;
      const next = makeItems(total).map((item, i) => (i < kept ? item : `fresh-${i}`));
      harness.update({data: next});
      await harness.settle(50);
      return {
        remaps: countCalls(log, 'remapItemSizes'),
        resets: countCalls(log, 'resetItemSizes'),
      };
    }

    expect(await replaceFraction(70)).toMatchObject({remaps: 1, resets: 0});
    expect(await replaceFraction(55)).toMatchObject({remaps: 0, resets: 1});
  });

  it('prepending items falls back to the full type push', async () => {
    const {getItemType} = await mountWithSpies(100);
    const log = harness!.mirror.callLog;
    const fullPushesBefore = countCalls(log, 'setItemTypes');
    getItemType.mockClear();

    harness!.update({data: ['item-new-a', 'item-new-b', ...makeItems(100)]});
    await harness!.settle(50);

    expect(countCalls(log, 'setItemTypes')).toBe(fullPushesBefore + 1);
    expect(getItemType.mock.calls.length).toBeGreaterThanOrEqual(102);
    expect(harness!.handle.getTotalSize()).toBe(102 * 64);
  });

  it('with dataAppendFastPath off an append recomputes every type (baseline behaviour)', async () => {
    NitroListDevFlags.dataAppendFastPath = false;
    const {getItemType} = await mountWithSpies(300);
    getItemType.mockClear();

    harness!.update({data: makeItems(305)});
    await harness!.settle(50);

    expect(getItemType.mock.calls.length).toBeGreaterThanOrEqual(305);
  });

  it('appending to a multi-column list resumes the row packing from the first new item', async () => {
    const spanOf = (index: number) => (index % 7 === 0 ? 2 : 1);
    const overrideItemLayout = jest.fn((layout: {span: number}, _item: string, index: number) => {
      layout.span = spanOf(index);
    });
    harness = renderNitroList({
      data: makeItems(200),
      renderItem: () => null,
      estimatedItemSize: 64,
      keyExtractor: itemKey,
      numColumns: 2,
      overrideItemLayout: overrideItemLayout as (
        layout: {span: number},
        item: string,
        index: number,
      ) => void,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    overrideItemLayout.mockClear();

    harness.update({data: makeItems(204)});
    await harness.settle(50);
    expect(overrideItemLayout.mock.calls.length).toBeLessThanOrEqual(4);

    const fresh = renderNitroList({
      data: makeItems(204),
      renderItem: () => null,
      estimatedItemSize: 64,
      keyExtractor: itemKey,
      numColumns: 2,
      overrideItemLayout: (layout: {span: number}, _item: string, index: number) => {
        layout.span = spanOf(index);
      },
    });
    fresh.layout(VIEWPORT_W, VIEWPORT_H);
    await fresh.settle(50);
    const tail = Math.max(0, harness.handle.getTotalSize() - VIEWPORT_H);
    harness.scroll(tail);
    fresh.scroll(tail);
    await harness.settle(50);
    await fresh.settle(50);

    const incremental = harness.cellInstances();
    const reference = fresh.cellInstances();
    let compared = 0;
    for (const [index, cell] of incremental) {
      const other = reference.get(index);
      if (other == null) continue;
      expect(cell.props.columnLeft).toBe(other.props.columnLeft);
      expect(cell.props.columnWidth).toBe(other.props.columnWidth);
      expect(cell.props.top).toBe(other.props.top);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
    expect(Math.max(...incremental.keys())).toBeGreaterThanOrEqual(200);
    fresh.unmount();
  });

  it('warns once when getItemType produces more distinct types than the engine tracks', async () => {
    harness = renderNitroList({
      data: makeItems(4200),
      renderItem: () => null,
      estimatedItemSize: 64,
      keyExtractor: itemKey,
      getItemType: (item: string) => item,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    const warnings = warnSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes('distinct types'),
    );
    expect(warnings.length).toBe(1);
  });
});
