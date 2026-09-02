import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {useEffect} from 'react';

import {NitroListDevFlags} from '../devFlags';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {clearWarnDevOnceForTests} from '../devWarnings';
import {clearMeasurementCache} from '../measurementCache';
import type {NitroListRenderItem} from '../NitroList';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import type {HybridMirrorConfig} from './helpers/layoutCoreMirror';

const VIEWPORT_W = 400;
const VIEWPORT_H = 800;
const ITEM_SIZE = 64;
const ITEM_COUNT = 1000;

describe('scripted bench driver churn', () => {
  let harness: NitroListHarness | null = null;
  const flagsBefore = {...NitroListDevFlags};

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMeasurementCache();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    Object.assign(NitroListDevFlags, flagsBefore);
    clearMeasurementCache();
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    jest.restoreAllMocks();
  });

  async function runDriver(
    options: {
      echoSkewDp?: number;
      echoDelayMs?: number;
      mirrorConfig?: HybridMirrorConfig;
      countJsi?: boolean;
    } = {},
  ): Promise<{
    mountsPerItem: number;
    mounts: number;
    itemsTraversed: number;
    jsiPerTick: number;
  }> {
    const mounts = new Map<number, number>();
    const Cell = ({index}: {index: number}) => {
      useEffect(() => {
        mounts.set(index, (mounts.get(index) ?? 0) + 1);
      }, [index]);
      return null;
    };
    const renderItem: NitroListRenderItem<string> = ({index, target}) =>
      target === 'Cell' ? <Cell index={index} /> : null;

    harness = renderNitroList(
      {
        data: makeItems(ITEM_COUNT),
        renderItem,
        estimatedItemSize: ITEM_SIZE,
        keyExtractor: itemKey,
        getItemType: () => 'row',
        drawDistance: 500,
      },
      options.mirrorConfig,
    );
    harness.echoOffsetSkewDp = options.echoSkewDp ?? 0;
    harness.echoDelayMs = options.echoDelayMs ?? 0;
    harness.layout(VIEWPORT_W, VIEWPORT_H);
    harness.measureAllCells(() => ITEM_SIZE);
    await harness.settle(50);

    const STEP_DP = 33;
    const TICKS = 120;
    mounts.clear();
    if (options.countJsi === true) NitroListPerfMonitor.enable();
    for (let tick = 1; tick <= TICKS; tick++) {
      const offset = tick * STEP_DP;
      harness.handle.scrollToOffset({offset, animated: false});
      await harness.settle(16);
      harness.measureUnmeasuredCells(() => ITEM_SIZE);
    }
    const jsiCalls = options.countJsi === true ? NitroListPerfMonitor.getSnapshot().jsiCalls : 0;
    NitroListPerfMonitor.disable();
    const traveled = TICKS * STEP_DP;
    const itemsTraversed = Math.ceil(traveled / ITEM_SIZE);
    let total = 0;
    for (const count of mounts.values()) total += count;
    return {
      mountsPerItem: total / itemsTraversed,
      mounts: total,
      itemsTraversed,
      jsiPerTick: jsiCalls / TICKS,
    };
  }

  it('mounts each traversed item about once (régua: mounts/item)', async () => {
    const result = await runDriver();
    console.info('MOUNTS_PER_ITEM exact-echo', JSON.stringify(result));
    expect(result.mountsPerItem).toBeLessThan(2);
  });

  it('a sub-frame echo one dp off the target does not churn the window', async () => {
    const result = await runDriver({echoSkewDp: 1});
    console.info('MOUNTS_PER_ITEM skewed-echo', JSON.stringify(result));
    expect(result.mountsPerItem).toBeLessThan(2);
  });

  it('the directional regime adds no churn when the offset stream is noisy', async () => {
    const withBuffers = await runDriver({echoSkewDp: -33, echoDelayMs: 8});
    harness?.unmount();
    harness = null;
    const withoutBuffers = await runDriver({
      echoSkewDp: -33,
      echoDelayMs: 8,
      mirrorConfig: {directionalBuffers: false},
    });
    console.info(
      'MOUNTS_PER_ITEM lagging-echo',
      JSON.stringify({withBuffers, withoutBuffers}),
    );
    expect(withBuffers.mounts).toBe(withoutBuffers.mounts);
  });

  it('a lagging echo costs no more than an exact one', async () => {
    const lagging = await runDriver({echoSkewDp: -33, echoDelayMs: 8});
    harness?.unmount();
    harness = null;
    const exact = await runDriver();
    console.info('MOUNTS_PER_ITEM lagging-vs-exact', JSON.stringify({lagging, exact}));
    expect(lagging.mounts).toBe(exact.mounts);
  });

  it('reads the layout cache instead of the engine during a scroll', async () => {
    const result = await runDriver({echoSkewDp: -33, echoDelayMs: 8, countJsi: true});
    console.info('JSI_PER_TICK', JSON.stringify(result));
    expect(result.jsiPerTick).toBeLessThanOrEqual(3.5);
  });

  it('a programmatic scroll repositions no more cells than a finger scroll', async () => {
    const heightFor = (index: number) => 40 + (((index * 2654435761) >>> 0) % 161);

    async function run(driver: 'command' | 'finger') {
      const renderItem: NitroListRenderItem<string> = () => null;
      harness = renderNitroList({
        data: makeItems(2000),
        renderItem,
        estimatedItemSize: 120,
        keyExtractor: itemKey,
        getItemType: (_item, i) => `dyn${i % 3}`,
        drawDistance: 500,
      });
      harness.layout(VIEWPORT_W, VIEWPORT_H);
      harness.measureAllCells(heightFor);
      await harness.settle(50);
      NitroListPerfMonitor.enable();
      if (driver === 'finger') harness.beginDrag(0);
      for (let tick = 1; tick <= 60; tick++) {
        if (driver === 'command') {
          harness.handle.scrollToOffset({offset: tick * 100, animated: false});
        } else {
          harness.scroll(tick * 100);
        }
        await harness.settle(16);
        harness.measureUnmeasuredCells(heightFor);
      }
      const snapshot = NitroListPerfMonitor.getSnapshot();
      NitroListPerfMonitor.disable();
      harness.unmount();
      harness = null;
      clearMeasurementCache();
      return {
        mounts: snapshot.itemMounts,
        renders: snapshot.itemRenders,
        contentRenders: snapshot.itemContentRenders,
        rendersPerMount: snapshot.itemRenders / Math.max(1, snapshot.itemMounts),
      };
    }

    const command = await run('command');
    const finger = await run('finger');
    console.info('RENDERS_PER_MOUNT', JSON.stringify({command, finger}));
    expect(command.contentRenders).toBe(command.mounts);
    expect(finger.contentRenders).toBe(finger.mounts);
    expect(command.rendersPerMount).toBeLessThanOrEqual(finger.rendersPerMount + 0.1);
  }, 60000);

  it('does not churn with the directional buffers disabled', async () => {
    const result = await runDriver({mirrorConfig: {directionalBuffers: false}});
    console.info('MOUNTS_PER_ITEM no-directional', JSON.stringify(result));
    expect(result.mountsPerItem).toBeLessThan(2);
  });
});
