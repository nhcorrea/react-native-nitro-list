import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {useEffect} from 'react';
import {Dimensions, Text, View} from 'react-native';
import type {LayoutChangeEvent} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListProps, NitroListRenderScrollComponentProps} from '../NitroList';
import {NitroSectionList} from '../section-list';
import {itemKey, makeItems, renderNitroList, type NitroListHarness} from './helpers/harness';
import {clearMirrorsForTests, getLastMirror} from './helpers/mockNitroListHost';

let harness: NitroListHarness | undefined;
let mounts = 0;
const mountsById = new Map<string, number>();

function Row({id, label}: {id: string; label: string}) {
  useEffect(() => {
    mounts++;
    mountsById.set(id, (mountsById.get(id) ?? 0) + 1);
  }, [id]);
  return <Text>{label}</Text>;
}

function resets(): number {
  return getLastMirror().dataCommits.filter((config) => config[7] !== 0).length;
}

function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(node.props.children));
}

beforeEach(() => {
  jest.useFakeTimers();
  mounts = 0;
  mountsById.clear();
});

afterEach(() => {
  harness?.unmount();
  harness = undefined;
  jest.useRealTimers();
  clearWarnDevOnceForTests();
});

describe('callback identity (fronteira 1.1)', () => {
  const data = makeItems(30);

  function inlineProps(label: string): NitroListProps<string> {
    return {
      data,
      estimatedItemSize: 100,
      keyExtractor: (item) => item,
      getItemType: () => 'row',
      itemsAreEqual: (a, b) => a === b,
      ItemSeparatorComponent: () => null,
      renderItem: ({item}) => <Row id={item} label={`${label}:${item}`} />,
    };
  }

  it('keeps cells mounted and measured when the parent re-renders with inline callbacks', async () => {
    harness = renderNitroList(inlineProps('a'));
    harness.layout(400, 600);
    harness.measureAllCells(() => 150);
    await harness.settle(50);
    const mountedBefore = mounts;
    const resetsBefore = resets();
    const rendered = harness.renderedIndices();
    expect(mountedBefore).toBe(rendered.length);
    expect(harness.handle.getItemSize(0)).toBe(150);

    for (const label of ['b', 'c', 'd']) {
      harness.update(inlineProps(label));
      await harness.settle(50);
    }

    expect(mounts).toBe(mountedBefore);
    expect(resets()).toBe(resetsBefore);
    expect(harness.renderedIndices()).toEqual(rendered);
    expect(harness.handle.getItemSize(0)).toBe(150);
    expect(harness.handle.getItemSize(rendered[rendered.length - 1])).toBe(150);
    expect(labels(harness.renderer)[0]).toBe('d:item-0');
  });

  it('warns in dev when renderItem changes identity on many consecutive renders', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      harness = renderNitroList(inlineProps('a'));
      harness.layout(400, 600);
      await harness.settle(50);
      const warned = () =>
        warn.mock.calls.some(([message]) => String(message).includes('renderItem changed identity'));
      for (let k = 0; k < 9; k++) harness.update(inlineProps(`r${k}`));
      expect(warned()).toBe(false);
      harness.update(inlineProps('last'));
      expect(warned()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not resend item data to the engine when only callback identities change', async () => {
    harness = renderNitroList(inlineProps('a'));
    harness.layout(400, 600);
    harness.measureAllCells(() => 150);
    await harness.settle(50);
    const commitsBefore = harness.mirror.dataCommits.length;
    harness.update(inlineProps('b'));
    await harness.settle(50);
    expect(harness.mirror.dataCommits.length).toBe(commitsBefore);
  });

  it('re-renders content in place and re-supplies mounted sizes after a dataVersion bump', async () => {
    const mutable = [{id: 'a', text: 'one'}, {id: 'b', text: 'two'}];
    const props = (dataVersion: number): NitroListProps<{id: string; text: string}> => ({
      data: mutable,
      dataVersion,
      estimatedItemSize: 100,
      keyExtractor: (item) => item.id,
      renderItem: ({item}) => <Row id={item.id} label={item.text} />,
    });
    const list = renderNitroList(props(0));
    harness = list as unknown as NitroListHarness;
    list.layout(400, 600);
    list.measureAllCells(() => 150);
    await list.settle(50);
    const resetsBefore = resets();
    mutable[0].text = 'changed';

    list.update(props(1));
    await list.settle(50);

    expect(resets()).toBe(resetsBefore + 1);
    expect(mounts).toBe(2);
    expect(labels(list.renderer)).toEqual(['changed', 'two']);
    expect(list.handle.getItemSize(0)).toBe(150);
    expect(list.handle.getItemSize(1)).toBe(150);
    list.measureCell(0, 180);
    await list.settle(50);
    expect(list.handle.getItemSize(0)).toBe(180);
  });

  it('re-supplies mounted sizes when the font scale changes', async () => {
    const window = Dimensions.get('window');
    harness = renderNitroList(inlineProps('a'), {typeAverages: false});
    harness.layout(400, 600);
    harness.measureAllCells(() => 150);
    await harness.settle(50);
    const rendered = harness.renderedIndices();
    try {
      act(() => Dimensions.set({window: {...window, fontScale: window.fontScale + 0.25}}));
      await harness.settle(50);
      for (const index of rendered) expect(mountsById.get(`item-${index}`)).toBe(1);
      expect(harness.handle.getItemSize(0)).toBe(150);
    } finally {
      act(() => Dimensions.set({window}));
    }
  });

  it('re-supplies mounted sizes when auto-fixed sizes are turned off', async () => {
    const props: NitroListProps<string> = {
      data: makeItems(40),
      estimatedItemSize: 60,
      keyExtractor: itemKey,
      getItemType: () => 'row',
      autoFixedItemSizes: true,
      renderItem: () => null,
    };
    harness = renderNitroList(props, {typeAverages: false});
    harness.layout(400, 4000);
    harness.measureAllCells(() => 64);
    await harness.settle(50);
    const cells = harness.cellInstances();
    expect(cells.size).toBe(40);
    expect(cells.get(0)!.props.autoFixedSize).toBe(64);
    const resetsBefore = resets();

    harness.update({autoFixedItemSizes: false});
    await harness.settle(50);

    expect(resets()).toBe(resetsBefore + 1);
    expect(harness.cellInstances().get(0)!.props.autoFixedSize).toBeUndefined();
    expect(harness.handle.getItemSize(0)).toBe(64);
    expect(harness.handle.getItemSize(39)).toBe(64);
  });

  it('keeps section rows mounted when inline section callbacks change identity', async () => {
    clearMirrorsForTests();
    let scrollProps!: NitroListRenderScrollComponentProps;
    const fakeScrollRef = {scrollTo: () => {}, getScrollableNode: () => 1};
    const renderScrollComponent = (props: NitroListRenderScrollComponentProps) => {
      scrollProps = props;
      const refObject = props.ref as unknown as {current: unknown};
      if (refObject != null) refObject.current = fakeScrollRef;
      return <View>{props.children}</View>;
    };
    const sections = [
      {key: 'a', title: 'A', data: ['a0', 'a1', 'a2']},
      {key: 'b', title: 'B', data: ['b0', 'b1']},
    ];
    const element = (label: string) => (
      <NitroSectionList<string, (typeof sections)[number]>
        sections={sections}
        estimatedItemSize={100}
        renderScrollComponent={renderScrollComponent}
        keyExtractor={(item) => item}
        getItemType={() => 'row'}
        renderItem={({item}) => <Row id={item} label={`${label}:${item}`} />}
        renderSectionHeader={({section}) => <Text>{`${label}:${section.title}`}</Text>}
      />
    );
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(element('a'));
    });
    act(() => {
      scrollProps.onLayout({
        nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 900}},
      } as LayoutChangeEvent);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60);
    });
    const mountedBefore = mounts;
    const commitsBefore = getLastMirror().dataCommits.length;
    expect(mountedBefore).toBe(5);

    act(() => {
      renderer.update(element('b'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60);
    });

    expect(mounts).toBe(mountedBefore);
    expect(getLastMirror().dataCommits.length).toBe(commitsBefore);
    expect(labels(renderer)).toContain('b:a0');
    act(() => renderer.unmount());
  });
});
