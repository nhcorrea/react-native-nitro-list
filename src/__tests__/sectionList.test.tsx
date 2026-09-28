import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {createRef} from 'react';
import {Text, View} from 'react-native';
import type {LayoutChangeEvent} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListRenderScrollComponentProps} from '../NitroList';
import {
  flatIndexForLocation,
  flattenSections,
  NitroSectionList,
  type NitroSectionListHandle,
  type NitroSectionListViewToken,
} from '../section-list';
import {clearMirrorsForTests} from './helpers/mockNitroListHost';

type Section = {key?: string; title: string; data: string[]};

const SECTIONS: Section[] = [
  {key: 'a', title: 'A', data: ['a0', 'a1', 'a2']},
  {key: 'b', title: 'B', data: ['b0', 'b1']},
  {key: 'c', title: 'C', data: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']},
];

describe('flattenSections', () => {
  it('flattens headers, items, separators and footers with namespaced keys', () => {
    const flattened = flattenSections<string, Section>(SECTIONS, {
      keyExtractor: (item) => item,
      withHeaders: true,
      withFooters: true,
      withSeparators: true,
    });
    const kinds = flattened.rows.map((row) => row.kind);
    expect(kinds.slice(0, 7)).toEqual([
      'header',
      'item',
      'separator',
      'item',
      'separator',
      'item',
      'footer',
    ]);
    expect(flattened.rows[0].key).toBe('sa:h');
    expect(flattened.rows[1].key).toBe('sa:i:a0');
    expect(flattened.stickyHeaderIndices).toEqual([0, 7, 12]);
    expect(flattened.headerFlatIndex).toEqual([0, 7, 12]);
    expect(flattened.itemFlatIndex[1]).toEqual([8, 10]);
  });

  it('reuses wrappers only while their complete section context is unchanged', () => {
    const options = {withHeaders: true, withFooters: true, withSeparators: true};
    const before = flattenSections<string, Section>(SECTIONS, options);
    const changed = {...SECTIONS[1], title: 'New B', data: [...SECTIONS[1].data, 'b2']};
    const after = flattenSections<string, Section>([SECTIONS[0], changed, SECTIONS[2]], options, before);
    expect(after.rows[0]).toBe(before.rows[0]);
    expect(after.rows[1]).toBe(before.rows[1]);
    expect(after.rows[after.headerFlatIndex[1]]).not.toBe(before.rows[before.headerFlatIndex[1]]);
    expect(after.rows[after.headerFlatIndex[1]].section.title).toBe('New B');
    const moved = flattenSections<string, Section>([SECTIONS[1], SECTIONS[0]], options, before);
    expect(moved.rows[moved.headerFlatIndex[1]]).not.toBe(before.rows[0]);
    expect(moved.rows[moved.headerFlatIndex[1]].sectionIndex).toBe(1);
  });

  it('maps scrollToLocation coordinates onto flat indices (0 = section header)', () => {
    const flattened = flattenSections<string, Section>(SECTIONS, {
      withHeaders: true,
      withFooters: false,
      withSeparators: false,
    });
    expect(flatIndexForLocation(flattened, 0, 0)).toBe(0);
    expect(flatIndexForLocation(flattened, 0, 1)).toBe(1);
    expect(flatIndexForLocation(flattened, 1, 2)).toBe(6);
    expect(flatIndexForLocation(flattened, 2, 99)).toBe(17);
    expect(flatIndexForLocation(flattened, 9, 0)).toBeNull();
  });

  it('keeps locations and row context correct when row decorations change', () => {
    const sections = [SECTIONS[0], {key: 'empty', title: 'Empty', data: []}, SECTIONS[1]];
    const optionsFor = (mask: number) => ({
      keyExtractor: (item: string, index: number) => `${index}:${item}`,
      withHeaders: (mask & 1) !== 0,
      withFooters: (mask & 2) !== 0,
      withSeparators: (mask & 4) !== 0,
    });
    for (let beforeMask = 0; beforeMask < 8; ++beforeMask) {
      const before = flattenSections(sections, optionsFor(beforeMask));
      const savedRows = before.rows.slice();
      for (let afterMask = 0; afterMask < 8; ++afterMask) {
        const options = optionsFor(afterMask);
        const after = flattenSections(sections, options, before);
        expect(after).toEqual(flattenSections(sections, options));
        for (const row of after.rows) {
          const old = savedRows.find((candidate) => candidate.key === row.key);
          if (old != null) expect(row).toBe(old);
        }
      }
      expect(before.rows).toEqual(savedRows);
      before.rows.forEach((row, index) => expect(row).toBe(savedRows[index]));
    }
  });

  it('invalidates changed keys and item positions even within the same section object', () => {
    const section = {key: 'mutable', title: 'Mutable', data: ['a', 'b', 'c']};
    const options = {
      keyExtractor: (item: string, index: number) => `${index}:${item}`,
      withHeaders: true,
      withFooters: true,
      withSeparators: true,
    };
    const before = flattenSections([section], options);
    section.data.splice(0, 1);
    const after = flattenSections([section], options, before);
    expect(after).toEqual(flattenSections([section], options));
    expect(after.rows[1]).not.toBe(before.rows[1]);
    expect(before.rows[1]).toMatchObject({kind: 'item', item: 'a', itemIndex: 0});
    const nextOptions = {...options, keyExtractor: (item: string) => `new:${item}`};
    expect(flattenSections([section], nextOptions, after)).toEqual(
      flattenSections([section], nextOptions),
    );
  });
});

describe('NitroSectionList (T31)', () => {
  let renderer: ReactTestRenderer;
  let warnSpy: ReturnType<typeof jest.spyOn>;
  let scrollProps: NitroListRenderScrollComponentProps;

  beforeEach(() => {
    jest.useFakeTimers();
    clearMirrorsForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    jest.useRealTimers();
    clearWarnDevOnceForTests();
    warnSpy.mockRestore();
  });

  const fakeScrollRef = {
    scrollTo: () => {},
    getScrollableNode: () => 1,
  };

  function renderScrollComponent(props: NitroListRenderScrollComponentProps) {
    scrollProps = props;
    const refObject = props.ref as unknown as {current: unknown};
    if (refObject != null) refObject.current = fakeScrollRef;
    return <View testID="fake-scroll">{props.children}</View>;
  }

  function layout(width: number, height: number): void {
    act(() => {
      scrollProps.onLayout({
        nativeEvent: {layout: {x: 0, y: 0, width, height}},
      } as LayoutChangeEvent);
    });
  }

  it('refreshes flattened content and locations on dataVersion with stable section references', async () => {
    const ref = createRef<NitroSectionListHandle>();
    const sections = [{key: 'mutable', title: 'Mutable', data: ['a', 'b']}];
    const renderItem = ({item}: {item: string}) => <Text testID={`row-${item}`}>{item}</Text>;
    const keyExtractor = (item: string) => item;
    const renderList = (dataVersion: number) => (
      <NitroSectionList<string, Section>
        ref={ref}
        sections={sections}
        dataVersion={dataVersion}
        estimatedItemSize={100}
        renderScrollComponent={renderScrollComponent}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
      />
    );
    act(() => { renderer = create(renderList(0)); });
    layout(400, 600);
    await act(async () => { await jest.advanceTimersByTimeAsync(60); });
    expect(renderer.root.findAllByProps({testID: 'row-a'}).length).toBeGreaterThan(0);

    sections[0].data.splice(0, 1, 'updated');
    sections[0].data.push('appended');
    act(() => { renderer.update(renderList(1)); });
    await act(async () => { await jest.advanceTimersByTimeAsync(60); });
    expect(renderer.root.findAllByProps({testID: 'row-a'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'row-updated'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'row-appended'}).length).toBeGreaterThan(0);
    expect(ref.current!.getLayout(2)).toBeDefined();

    sections[0].data.splice(1);
    act(() => { renderer.update(renderList(2)); });
    await act(async () => { await jest.advanceTimersByTimeAsync(60); });
    expect(renderer.root.findAllByProps({testID: 'row-b'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'row-appended'})).toHaveLength(0);
    expect(ref.current!.getLayout(1)).toBeUndefined();
  });

  it('renders rows by kind, wires sticky headers and translates scrollToLocation', async () => {
    const ref = createRef<NitroSectionListHandle>();
    const viewability = jest.fn();
    act(() => {
      renderer = create(
        <NitroSectionList<string, Section>
          ref={ref}
          sections={SECTIONS}
          estimatedItemSize={100}
          renderScrollComponent={renderScrollComponent}
          keyExtractor={(item) => item}
          renderItem={({item}) => <Text testID={`row-${item}`}>{item}</Text>}
          renderSectionHeader={({section}) => (
            <Text testID={`header-${section.title}`}>{section.title}</Text>
          )}
          viewabilityConfig={{itemVisiblePercentThreshold: 50}}
          onViewableItemsChanged={viewability}
        />,
      );
    });
    layout(400, 600);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60);
    });

    expect(renderer.root.findAllByProps({testID: 'header-A'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'row-a0'}).length).toBeGreaterThan(0);

    expect(viewability).toHaveBeenCalled();
    const call = viewability.mock.calls[0][0] as {
      viewableItems: Array<NitroSectionListViewToken<string, Section>>;
    };
    for (const token of call.viewableItems) {
      expect(typeof token.section.title).toBe('string');
      expect(token.item.length).toBe(2);
    }
    const first = call.viewableItems[0];
    expect(first.item).toBe('a0');
    expect(first.index).toBe(0);
    expect(first.sectionIndex).toBe(0);

    await act(async () => {
      const promise = ref.current?.scrollToLocation({sectionIndex: 2, itemIndex: 1});
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    const flatIndex = 8;
    expect(ref.current?.getAbsoluteLastScrollOffset()).toBeCloseTo(
      ref.current?.getItemOffset(flatIndex) ?? -1,
      0,
    );
  });
});
