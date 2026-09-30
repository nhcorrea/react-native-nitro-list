import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {itemKey, makeItems, renderNitroList} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('work after unmount (fronteira 1.8)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stops a converging scrollToIndex when the list unmounts', async () => {
    const active = renderNitroList<string>({
      data: makeItems(400),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    active.layout(VIEWPORT_W, VIEWPORT_H);
    await active.settle(50);
    const landing = active.handle.scrollToIndex({index: 300});
    active.frame(16);
    active.unmount();
    const issued = active.scrollCommands.length;
    await active.settle(3000);
    await landing;
    expect(active.scrollCommands.length).toBe(issued);
  });

  it('does not stick to the end after the list unmounts', async () => {
    const active = renderNitroList<string>({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      maintainScrollAtEnd: true,
    });
    active.layout(VIEWPORT_W, VIEWPORT_H);
    active.measureAllCells(() => 100);
    await active.settle(50);
    active.scroll(1400);
    active.measureUnmeasuredCells(() => 100);
    await active.settle(50);
    const issuedBefore = active.scrollCommands.length;
    active.update({data: makeItems(22)});
    active.unmount();
    await active.settle(3000);
    expect(active.scrollCommands.length).toBe(issuedBefore);
  });
});
