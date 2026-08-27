import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {act} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('imperative promises + readiness gate (T21)', () => {
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

  function mount(count: number = 100): void {
    harness = renderNitroList({
      data: makeItems(count),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
  }

  async function resolved(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    return done;
  }

  it('scrollToOffset resolves after the jump lands', async () => {
    mount();
    await harness.settle(50);
    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToOffset({offset: 1200});
    });
    expect(await resolved(promise)).toBe(false);
    await harness.settle(50);
    expect(await resolved(promise)).toBe(true);
    expect(harness.lastScrollTop()).toBe(1200);
  });

  it('animated scrollToOffset resolves when momentum ends', async () => {
    mount();
    await harness.settle(50);
    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToOffset({offset: 900, animated: true});
    });
    await harness.settle(30);
    expect(await resolved(promise)).toBe(false);
    harness.momentumEnd(900);
    expect(await resolved(promise)).toBe(true);
  });

  it('animated scrollToOffset resolves via the settle fallback when no momentum events arrive', async () => {
    mount();
    await harness.settle(50);
    harness.echoProgrammaticScrolls = false;
    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToOffset({offset: 900, animated: true});
    });
    await harness.settle(750);
    expect(await resolved(promise)).toBe(true);
  });

  it('a superseding command always resolves the previous promise first', async () => {
    mount(300);
    await harness.settle(50);
    let first!: Promise<void>;
    act(() => {
      first = harness.handle.scrollToIndex({index: 250});
    });
    await harness.settle(20);
    let second!: Promise<void>;
    act(() => {
      second = harness.handle.scrollToOffset({offset: 500});
    });
    expect(await resolved(first)).toBe(true);
    await harness.settle(100);
    expect(await resolved(second)).toBe(true);
    expect(harness.lastScrollTop()).toBe(500);
  });

  it('unmount resolves every pending scroll promise', async () => {
    mount(300);
    await harness.settle(50);
    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToIndex({index: 250});
    });
    harness.unmount();
    expect(await resolved(promise)).toBe(true);
  });

  it('a scrollToIndex right after a data change waits for layout stability and still lands exactly', async () => {
    mount(100);
    await harness.settle(50);

    harness.update({data: makeItems(160)});
    let promise!: Promise<void>;
    act(() => {
      promise = harness.handle.scrollToIndex({index: 140});
    });
    for (let round = 0; round < 20; round++) {
      harness.measureAllCells(() => 100);
      await harness.settle(50);
    }
    await promise;
    expect(harness.lastScrollTop()).toBeCloseTo(harness.handle.getItemOffset(140), 0);
  });
});
