import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {useEffect} from 'react';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';

const VIEWPORT_W = 400;
const VIEWPORT_H = 600;

describe('sticky header integration', () => {
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

  it('activates headers as they cross the bar and pushes the outgoing one off', async () => {
    const stickyChanges: number[] = [];
    const renderTargets: Array<{index: number; target: string}> = [];
    const renderItem: NitroListRenderItem<string> = ({index, target}) => {
      renderTargets.push({index, target});
      return null;
    };
    harness = renderNitroList({
      data: makeItems(100),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 10, 20],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    expect(harness.stickyTranslateY()).toBe(0);
    expect(renderTargets.some((r) => r.index === 0 && r.target === 'StickyHeader')).toBe(true);

    harness.scroll(950);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
    expect(harness.stickyTranslateY()).toBe(-50);

    harness.scroll(1050);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
    expect(harness.stickyTranslateY()).toBe(0);
    expect(renderTargets.some((r) => r.index === 10 && r.target === 'StickyHeader')).toBe(true);

    harness.scroll(400);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(0);
  });

  it('hideRelatedCell keeps the active header cell mounted but hidden', async () => {
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 10],
      stickyHeaderConfig: {hideRelatedCell: true},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    expect(harness.renderedIndices()).toContain(0);
    expect(harness.cellHidden(0)).toBe(true);
    expect(harness.cellHidden(1)).toBe(false);

    harness.scroll(1050);
    await harness.settle(50);
    expect(harness.renderedIndices()).toContain(10);
    expect(harness.cellHidden(10)).toBe(true);
    expect(harness.cellHidden(11)).toBe(false);
  });

  it('hideRelatedCell transitions never unmount or remount the hidden cell', async () => {
    const mounts = new Map<number, number>();
    const unmounts = new Map<number, number>();
    const Cell = ({index}: {index: number}) => {
      useEffect(() => {
        mounts.set(index, (mounts.get(index) ?? 0) + 1);
        return () => {
          unmounts.set(index, (unmounts.get(index) ?? 0) + 1);
        };
      }, [index]);
      return null;
    };
    const renderItem: NitroListRenderItem<string> = ({index, target}) =>
      target === 'Cell' ? <Cell index={index} /> : null;
    harness = renderNitroList({
      data: makeItems(100),
      renderItem,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 2],
      stickyHeaderConfig: {hideRelatedCell: true},
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    expect(harness.cellHidden(0)).toBe(true);
    expect(harness.cellHidden(2)).toBe(false);

    harness.scroll(250);
    await harness.settle(50);
    expect(harness.cellHidden(2)).toBe(true);
    expect(harness.cellHidden(0)).toBe(false);

    harness.scroll(100);
    await harness.settle(50);
    expect(harness.cellHidden(0)).toBe(true);
    expect(harness.cellHidden(2)).toBe(false);

    expect(mounts.get(0)).toBe(1);
    expect(mounts.get(2)).toBe(1);
    expect(unmounts.get(0)).toBeUndefined();
    expect(unmounts.get(2)).toBeUndefined();
  });

  it('same-content stickyHeaderIndices with a new identity does not disturb the active header (T20)', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 10, 20],
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);
    harness.scroll(1050);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
    const changesBefore = stickyChanges.length;

    harness.update({stickyHeaderIndices: [0, 10, 20]});
    await harness.settle(50);
    expect(stickyChanges.length).toBe(changesBefore);

    harness.update({stickyHeaderIndices: [0, 5]});
    harness.scroll(1051);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(5);
  });

  it('honors the configured sticky offset', async () => {
    const stickyChanges: number[] = [];
    harness = renderNitroList({
      data: makeItems(100),
      renderItem: () => null,
      estimatedItemSize: 100,
      keyExtractor: itemKey,
      stickyHeaderIndices: [0, 10],
      stickyHeaderConfig: {offset: 40},
      onChangeStickyIndex: (index) => {
        stickyChanges.push(index);
      },
    });
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => 100);
    await harness.settle(50);

    harness.scroll(965);
    expect(stickyChanges[stickyChanges.length - 1]).toBe(10);
    expect(harness.stickyTranslateY()).toBe(40);
  });
});
