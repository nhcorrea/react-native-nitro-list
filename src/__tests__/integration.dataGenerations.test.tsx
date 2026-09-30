import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View} from 'react-native';
import type {LayoutChangeEvent} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import type {NitroListProps, NitroListRenderScrollComponentProps} from '../NitroList';
import {NitroSectionList, type NitroSectionListProps} from '../section-list';
import {reachableLabels} from './helpers/gc';
import {renderNitroList, type NitroListHarness} from './helpers/harness';
import {clearMirrorsForTests} from './helpers/mockNitroListHost';

type Item = {id: string; type: string};
type Section = {key: string; title: string; data: Item[]};
type Refs = Map<string, WeakRef<object>>;
type SectionProps = NitroSectionListProps<Item, Section>;
type Scenario = {
  name: string;
  stableKeys: boolean;
  scrolls?: boolean;
  extra: Partial<NitroListProps<Item>>;
  between?: (harness: NitroListHarness<Item>) => void;
  exercised?: (harness: NitroListHarness<Item>) => void;
};

const GENERATIONS = ['A', 'B', 'C', 'D', 'E'] as const;
const CURRENT = ['E:array', 'E:first', 'E:last'];
const ITEM_COUNT = 400;
const calls = {viewable: 0, endReached: 0, firstVisible: 0};

function makeGeneration(tag: string, stableKeys: boolean, count: number = ITEM_COUNT): Item[] {
  return Array.from({length: count}, (_, index) => ({
    id: stableKeys ? `item-${index}` : `${tag}-${index}`,
    type: index % 3 === 0 ? 'wide' : 'narrow',
  }));
}

function generationProps(items: Item[]): Pick<
  NitroListProps<Item>,
  'data' | 'renderItem' | 'keyExtractor' | 'getItemType' | 'onEndReached' | 'onViewableItemsChanged' | 'onLoad'
> {
  return {
    data: items,
    renderItem: () => (items.length > 0 ? null : null),
    keyExtractor: (item) => (items.length > 0 ? item.id : ''),
    getItemType: (item) => (items.length > 0 ? item.type : ''),
    onEndReached: () => {
      if (items.length > 0) calls.endReached++;
    },
    onViewableItemsChanged: () => {
      if (items.length > 0) calls.viewable++;
    },
    onLoad: () => void items,
  };
}

function watch(refs: Refs, tag: string, items: Item[]): void {
  refs.set(`${tag}:array`, new WeakRef(items));
  refs.set(`${tag}:first`, new WeakRef(items[0]));
  refs.set(`${tag}:last`, new WeakRef(items[items.length - 1]));
}

function cycleFiberBuffers(harness: NitroListHarness<Item>, items: Item[]): void {
  harness.update(generationProps(items));
  harness.update(generationProps(items));
  harness.frame(32);
}

function exercise(harness: NitroListHarness<Item>, scrolls: boolean): void {
  harness.measureUnmeasuredCells(() => 100);
  harness.frame(32);
  if (!scrolls) return;
  harness.scroll(39400);
  harness.measureUnmeasuredCells(() => 100);
  harness.frame(32);
  harness.scroll(0);
  harness.frame(32);
}

function replaceData(
  harness: NitroListHarness<Item>,
  refs: Refs,
  tag: string,
  scenario: Scenario,
  between?: (harness: NitroListHarness<Item>) => void,
): void {
  const items = makeGeneration(tag, scenario.stableKeys);
  watch(refs, tag, items);
  harness.update(generationProps(items));
  exercise(harness, scenario.scrolls !== false);
  between?.(harness);
  cycleFiberBuffers(harness, items);
}

function runGenerations(refs: Refs, scenario: Scenario): NitroListHarness<Item> {
  const items = makeGeneration('A', scenario.stableKeys);
  watch(refs, 'A', items);
  const harness = renderNitroList<Item>({
    estimatedItemSize: 100,
    ...scenario.extra,
    ...generationProps(items),
  });
  harness.layout(400, 600);
  exercise(harness, scenario.scrolls !== false);
  replaceData(harness, refs, 'B', scenario, scenario.between);
  for (const tag of GENERATIONS.slice(2)) replaceData(harness, refs, tag, scenario);
  jest.runOnlyPendingTimers();
  return harness;
}

function sectionProps(
  refs: Refs,
  tag: string,
  renderScrollComponent: SectionProps['renderScrollComponent'],
): SectionProps {
  const sections: Section[] = ['x', 'y', 'z'].map((key) => ({
    key,
    title: `${tag}-${key}`,
    data: makeGeneration(key, true, 40),
  }));
  refs.set(`${tag}:array`, new WeakRef(sections));
  refs.set(`${tag}:first`, new WeakRef(sections[0].data[0]));
  refs.set(`${tag}:last`, new WeakRef(sections[2]));
  return withFreshRenderers({
    sections,
    estimatedItemSize: 100,
    renderScrollComponent,
    renderItem: () => null,
    keyExtractor: (item) => (sections.length > 0 ? item.id : ''),
    getItemType: (item) => (sections.length > 0 ? item.type : ''),
    viewabilityConfig: {itemVisiblePercentThreshold: 50},
    onViewableItemsChanged: () => {
      if (sections.length > 0) calls.viewable++;
    },
  });
}

function withFreshRenderers(props: SectionProps): SectionProps {
  const sections = props.sections;
  return {
    ...props,
    renderItem: () => (sections.length > 0 ? null : null),
    renderSectionHeader: () => (sections.length > 0 ? null : null),
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'sticky headers that change between generations',
    stableKeys: false,
    extra: {stickyHeaderIndices: [0]},
    between: (harness) => harness.update({stickyHeaderIndices: [0, 10]}),
  },
  {
    name: 'cells that survive the replacement through stable keys',
    stableKeys: true,
    scrolls: false,
    extra: {},
    exercised: (harness) => {
      expect(harness.renderedIndices()).toContain(0);
    },
  },
  {
    name: 'viewability, position maintenance and edge callbacks',
    stableKeys: true,
    extra: {
      maintainVisibleContentPosition: true,
      viewabilityConfig: {itemVisiblePercentThreshold: 50},
      onEndReachedThreshold: 0.5,
      onFirstVisibleItemChanged: () => {
        calls.firstVisible++;
      },
      adaptiveRenderMode: true,
    },
    exercised: () => {
      expect(calls.viewable).toBeGreaterThan(0);
      expect(calls.endReached).toBeGreaterThan(0);
      expect(calls.firstVisible).toBeGreaterThan(0);
    },
  },
  {
    name: 'auto-fixed item sizes',
    stableKeys: true,
    extra: {autoFixedItemSizes: true},
    between: (harness) => {
      for (let offset = 600; offset <= 9000; offset += 600) {
        harness.scroll(offset);
        harness.measureUnmeasuredCells(() => 100);
        harness.frame(32);
      }
      harness.scroll(0);
      harness.frame(32);
    },
    exercised: (harness) => {
      expect(harness.cellInstances().get(0)?.props.autoFixedSize).toBe(100);
    },
  },
  {
    name: 'a grid with spans',
    stableKeys: false,
    extra: {
      numColumns: 2,
      overrideItemLayout: (layout, item) => {
        layout.span = item.type === 'wide' ? 2 : 1;
      },
    },
  },
  {
    name: 'the ui-thread scroll driver',
    stableKeys: true,
    extra: {experimentalUiThreadScroll: true, stickyHeaderIndices: [0]},
  },
];

describe('data generations (fronteira 1.7)', () => {
  let harness: NitroListHarness<Item> | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    calls.viewable = 0;
    calls.endReached = 0;
    calls.firstVisible = 0;
  });

  afterEach(() => {
    harness?.unmount();
    harness = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(SCENARIOS)('keeps only the current generation reachable with $name', async (scenario) => {
    const refs: Refs = new Map();
    harness = runGenerations(refs, scenario);
    scenario.exercised?.(harness);
    expect(await reachableLabels(refs)).toEqual(CURRENT);
  });

  it('keeps only the current sections reachable in a section list', async () => {
    const refs: Refs = new Map();
    const state: {
      props: SectionProps | null;
      renderer: ReactTestRenderer | null;
      scroll: NitroListRenderScrollComponentProps | null;
    } = {props: null, renderer: null, scroll: null};
    const renderScrollComponent = (props: NitroListRenderScrollComponentProps) => {
      state.scroll = props;
      return <View>{props.children}</View>;
    };
    const render = () => {
      act(() => {
        const element = <NitroSectionList<Item, Section> {...state.props!} />;
        if (state.renderer == null) state.renderer = create(element);
        else state.renderer.update(element);
      });
    };
    const advance = (tag: string) => {
      state.props = sectionProps(refs, tag, renderScrollComponent);
      render();
      if (tag === 'A') {
        act(() => {
          state.scroll!.onLayout({
            nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 600}},
          } as LayoutChangeEvent);
        });
      }
      state.props = withFreshRenderers(state.props);
      render();
      state.props = withFreshRenderers(state.props);
      render();
      act(() => {
        jest.advanceTimersByTime(32);
      });
    };
    clearMirrorsForTests();
    GENERATIONS.forEach(advance);
    jest.runOnlyPendingTimers();
    const alive = await reachableLabels(refs);
    act(() => {
      state.renderer!.unmount();
    });
    expect(calls.viewable).toBeGreaterThan(0);
    expect(alive).toEqual(CURRENT);
  });
});
