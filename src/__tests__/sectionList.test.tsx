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
