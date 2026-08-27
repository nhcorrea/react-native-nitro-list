import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListRenderItem, NitroListRenderMode} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('adaptive render mode (T33, gate)', () => {
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

  function fling(from: number, stepDp: number, steps: number): void {
    for (let i = 1; i <= steps; i++) {
      harness.frame(16);
      harness.scroll(from + stepDp * i);
    }
  }

  it('enters fast mode above the Schmitt threshold and exits after the settle delay', async () => {
    const seenModes: NitroListRenderMode[] = [];
    const renderItem: NitroListRenderItem<string> = ({renderMode}) => {
      seenModes.push(renderMode ?? 'normal');
      return null;
    };
    harness = renderNitroList({
      data: makeItems(500),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      adaptiveRenderMode: true,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    expect(seenModes[seenModes.length - 1]).toBe('normal');

    fling(0, 80, 6);
    expect(seenModes[seenModes.length - 1]).toBe('fast');

    fling(480, 8, 4);
    expect(seenModes[seenModes.length - 1]).toBe('fast');
    await harness.settle(300);
    expect(seenModes[seenModes.length - 1]).toBe('normal');
  });

  it('stays in normal mode when the gate prop is off', async () => {
    const seenModes: Array<NitroListRenderMode | undefined> = [];
    const renderItem: NitroListRenderItem<string> = ({renderMode}) => {
      seenModes.push(renderMode);
      return null;
    };
    harness = renderNitroList({
      data: makeItems(500),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    await harness.settle(50);
    fling(0, 80, 6);
    expect(seenModes.every((mode) => mode === 'normal')).toBe(true);
  });
});
