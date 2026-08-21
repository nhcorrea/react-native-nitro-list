import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('edge callbacks integration', () => {
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

  it('onEndReached latches at the threshold, re-arms by hysteresis and re-fires on growth', async () => {
    const onEndReached = jest.fn();
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      onEndReached: onEndReached as (info: {distanceFromEnd: number}) => void,
      onEndReachedThreshold: 0.5,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(1150);
    expect(onEndReached).toHaveBeenCalledTimes(1);
    expect(onEndReached.mock.calls[0][0]).toEqual({distanceFromEnd: 250});

    harness.scroll(1160);
    harness.scroll(1250);
    expect(onEndReached).toHaveBeenCalledTimes(1);

    harness.scroll(1000);
    harness.scroll(1150);
    expect(onEndReached).toHaveBeenCalledTimes(2);

    harness.scroll(1390);
    expect(onEndReached).toHaveBeenCalledTimes(2);
    harness.update({data: makeItems(22)});
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    expect(onEndReached).toHaveBeenCalledTimes(3);
    expect(onEndReached.mock.calls[2][0]).toEqual({distanceFromEnd: 22 * 100 - 1390 - VIEWPORT_H});
  });

  it('a large jump does not re-arm a latched edge, but opposite-edge firing still works (T12)', async () => {
    const onEndReached = jest.fn();
    const onStartReached = jest.fn();
    harness = renderNitroList({
      data: makeItems(20),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      onEndReached: onEndReached as (info: {distanceFromEnd: number}) => void,
      onEndReachedThreshold: 0.5,
      onStartReached: onStartReached as (info: {distanceFromStart: number}) => void,
      onStartReachedThreshold: 0.5,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    onStartReached.mockClear();

    harness.scroll(500);
    harness.scroll(1000);
    harness.scroll(1390);
    expect(onEndReached).toHaveBeenCalledTimes(1);

    harness.scroll(10);
    expect(onStartReached).toHaveBeenCalledTimes(1);

    harness.scroll(1390);
    expect(onEndReached).toHaveBeenCalledTimes(1);

    harness.scroll(1000);
    harness.scroll(1390);
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });
});
