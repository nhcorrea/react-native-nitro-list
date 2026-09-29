import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {engineMemoryReportsForTests} from './helpers/mockNitroListHost';

let harness: NitroListHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  harness?.unmount();
  harness = undefined;
  jest.useRealTimers();
});

describe('engine memory (fronteira 1.6)', () => {
  it('reports engine memory to the JS runtime only when the item count moves a lot', async () => {
    harness = renderNitroList({
      data: makeItems(100),
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      renderItem: () => null,
    });
    harness.layout(400, 800);
    await harness.settle(20);
    const reports = () => engineMemoryReportsForTests().map((report) => report.count);
    expect(reports()).toEqual([]);
    for (const count of [5000, 6000, 9000, 12000, 4000, 2500, 2000]) {
      harness.update({data: makeItems(count)});
      await harness.settle(20);
    }
    expect(reports()).toEqual([5000, 12000, 2500]);
  });

  it('disposes the engine when the list unmounts', async () => {
    harness = renderNitroList({
      data: makeItems(100),
      estimatedItemSize: 50,
      keyExtractor: itemKey,
      renderItem: () => null,
    });
    harness.layout(400, 800);
    await harness.settle(20);
    const mirror = harness.mirror;
    harness.unmount();
    harness = undefined;
    expect(mirror.disposed).toBe(true);
    expect(mirror.onRangeChange).toBeUndefined();
  });
});
