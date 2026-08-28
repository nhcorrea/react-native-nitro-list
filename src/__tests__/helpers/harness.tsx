import {jest} from '@jest/globals';
import React, {createRef} from 'react';
import {StyleSheet, View} from 'react-native';
import type {LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent} from 'react-native';
import {act, create, type ReactTestInstance, type ReactTestRenderer} from 'react-test-renderer';

import {NitroList} from '../../NitroList';
import type {
  NitroListHandle,
  NitroListProps,
  NitroListRenderScrollComponentProps,
} from '../../NitroList';
import {clearMirrorsForTests, getLastMirror, setMirrorConfigForTests} from './mockNitroListHost';
import {
  clearCreatedSharedValuesForTests,
  clearWebOnlyDependencyUsagesForTests,
  getCreatedSharedValuesForTests,
  getWebOnlyDependencyUsagesForTests,
} from './mockReanimated';
import type {HybridMirrorConfig, HybridNitroListViewMirror} from './layoutCoreMirror';

export type ScrollCommand = {y: number; animated: boolean};

export function makeItems(count: number, offset: number = 0): string[] {
  const items: string[] = [];
  for (let i = 0; i < count; i++) items.push(`item-${i + offset}`);
  return items;
}

export function itemKey(item: string): string {
  return item;
}

function makeScrollEvent(y: number, horizontal: boolean = false): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: horizontal ? {x: y, y: 0} : {x: 0, y},
      contentInset: {top: 0, left: 0, bottom: 0, right: 0},
      contentSize: {width: 0, height: 0},
      layoutMeasurement: {width: 0, height: 0},
      zoomScale: 1,
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

function makeLayoutEvent(width: number, height: number): LayoutChangeEvent {
  return {
    nativeEvent: {layout: {x: 0, y: 0, width, height}},
  } as LayoutChangeEvent;
}

export class NitroListHarness<T = string> {
  renderer!: ReactTestRenderer;
  readonly ref = createRef<NitroListHandle>();
  scrollProps!: NitroListRenderScrollComponentProps;
  readonly scrollCommands: ScrollCommand[] = [];
  echoProgrammaticScrolls = true;
  horizontal = false;

  private props: NitroListProps<T>;
  private readonly measuredCells = new WeakSet<ReactTestInstance>();
  private readonly fakeScrollRef = {
    scrollTo: ({x, y, animated}: {x?: number; y?: number; animated?: boolean}) => {
      const target = (this.horizontal ? x : y) ?? 0;
      this.scrollCommands.push({y: target, animated: animated === true});
      if (this.echoProgrammaticScrolls) {
        setTimeout(() => {
          this.dispatchScroll(target);
        }, 0);
      }
    },
    getScrollableNode: () => 42,
    getNativeScrollRef: () => this.fakeScrollRef,
  };

  constructor(props: NitroListProps<T>) {
    this.props = props;
    this.horizontal = props.horizontal === true;
  }

  private renderScrollComponent = (
    scrollProps: NitroListRenderScrollComponentProps,
  ): React.ReactElement => {
    this.scrollProps = scrollProps;
    const refObject = scrollProps.ref as unknown as {current: unknown} | null;
    if (refObject != null && typeof refObject === 'object') {
      refObject.current = this.fakeScrollRef;
    }
    return <View testID="fake-scroll-view">{scrollProps.children}</View>;
  };

  private element(props: NitroListProps<T>): React.ReactElement {
    return (
      <NitroList<T>
        ref={this.ref}
        renderScrollComponent={this.renderScrollComponent}
        {...props}
      />
    );
  }

  mount(): this {
    act(() => {
      this.renderer = create(this.element(this.props));
    });
    return this;
  }

  update(next: Partial<NitroListProps<T>>): void {
    this.props = {...this.props, ...next};
    act(() => {
      this.renderer.update(this.element(this.props));
    });
  }

  unmount(): void {
    act(() => {
      this.renderer.unmount();
    });
  }

  get mirror(): HybridNitroListViewMirror {
    return getLastMirror();
  }

  get handle(): NitroListHandle {
    const current = this.ref.current;
    if (current == null) throw new Error('NitroList handle is not attached');
    return current;
  }

  layout(width: number, height: number): void {
    act(() => {
      this.scrollProps.onLayout(makeLayoutEvent(width, height));
    });
  }

  dispatchScroll(y: number): void {
    (this.scrollProps.onScroll as (e: NativeSyntheticEvent<NativeScrollEvent>) => void)(
      makeScrollEvent(y, this.horizontal),
    );
  }

  scroll(y: number): void {
    act(() => {
      this.dispatchScroll(y);
    });
  }

  beginDrag(y?: number): void {
    act(() => {
      this.scrollProps.onScrollBeginDrag(makeScrollEvent(y ?? this.lastScrollTop(), this.horizontal));
    });
  }

  endDrag(y: number): void {
    act(() => {
      this.scrollProps.onScrollEndDrag(makeScrollEvent(y, this.horizontal));
    });
  }

  momentumBegin(y: number): void {
    act(() => {
      this.scrollProps.onMomentumScrollBegin(makeScrollEvent(y, this.horizontal));
    });
  }

  momentumEnd(y: number): void {
    act(() => {
      this.scrollProps.onMomentumScrollEnd(makeScrollEvent(y, this.horizontal));
    });
  }

  lastScrollTop(): number {
    return this.handle.getAbsoluteLastScrollOffset();
  }

  frame(ms: number = 16): void {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  }

  async settle(ms: number = 2000): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  cellInstances(): Map<number, ReactTestInstance> {
    const cells = new Map<number, ReactTestInstance>();
    for (const instance of this.renderer.root.findAll(
      (node) =>
        typeof node.type === 'function' &&
        node.props != null &&
        typeof node.props.index === 'number' &&
        typeof node.props.top === 'number' &&
        node.props.enqueueItemSize != null,
    )) {
      cells.set(instance.props.index as number, instance);
    }
    return cells;
  }

  renderedIndices(): number[] {
    return Array.from(this.cellInstances().keys()).sort((a, b) => a - b);
  }

  measureCell(index: number, height: number): void {
    const cell = this.cellInstances().get(index);
    if (cell == null) throw new Error(`cell ${index} is not rendered`);
    const target = cell.findAll(
      (node) => node.type === View && node.props.onLayout != null,
    )[0];
    if (target == null) throw new Error(`cell ${index} has no measurable View`);
    act(() => {
      target.props.onLayout(
        this.horizontal ? makeLayoutEvent(height, 0) : makeLayoutEvent(0, height),
      );
    });
  }

  private structuralLayoutViews(): ReactTestInstance[] {
    const insideMockHost = (node: ReactTestInstance): boolean => {
      let parent: ReactTestInstance | null = node.parent;
      while (parent != null) {
        if (parent.props?.testID === 'mock-nitro-list-view') return true;
        parent = parent.parent;
      }
      return false;
    };
    return this.renderer.root.findAll(
      (node) =>
        node.type === View &&
        node.props.onLayout != null &&
        node.props.collapsable === undefined &&
        !insideMockHost(node),
    );
  }

  measureStickyOverlay(size: number): void {
    const overlay = this.renderer.root.findAll(
      (node) =>
        node.type === View &&
        node.props.pointerEvents === 'box-none' &&
        node.props.onLayout != null,
    )[0];
    if (overlay == null) throw new Error('sticky overlay is not rendered');
    act(() => {
      overlay.props.onLayout(
        this.horizontal ? makeLayoutEvent(size, 0) : makeLayoutEvent(0, size),
      );
    });
  }

  layoutHeader(height: number): void {
    const views = this.structuralLayoutViews();
    if (views.length === 0) throw new Error('no header/footer wrapper is rendered');
    act(() => {
      views[0].props.onLayout(
        this.horizontal ? makeLayoutEvent(height, 0) : makeLayoutEvent(0, height),
      );
    });
  }

  layoutFooter(height: number): void {
    const views = this.structuralLayoutViews();
    if (views.length === 0) throw new Error('no header/footer wrapper is rendered');
    act(() => {
      views[views.length - 1].props.onLayout(
        this.horizontal ? makeLayoutEvent(height, 0) : makeLayoutEvent(0, height),
      );
    });
  }

  wrapperOpacity(): number | undefined {
    const outer = this.renderer.root.findAll((node) => node.type === View)[0];
    if (outer == null) throw new Error('wrapper View not found');
    const flat = StyleSheet.flatten(outer.props.style) as {opacity?: number} | undefined;
    return flat?.opacity;
  }

  stickyTranslateY(): number {
    const sticky = getCreatedSharedValuesForTests()[0];
    if (sticky == null) throw new Error('no shared values were created yet');
    return sticky.value as number;
  }

  measureUnmeasuredCells(heightForIndex: (index: number) => number): number {
    const targets: Array<{index: number; onLayout: (event: LayoutChangeEvent) => void}> = [];
    for (const [index, cell] of this.cellInstances()) {
      if (this.measuredCells.has(cell)) continue;
      this.measuredCells.add(cell);
      const target = cell.findAll(
        (node) => node.type === View && node.props.onLayout != null,
      )[0];
      if (target != null) targets.push({index, onLayout: target.props.onLayout});
    }
    if (targets.length === 0) return 0;
    act(() => {
      for (const target of targets) {
        const size = heightForIndex(target.index);
        target.onLayout(this.horizontal ? makeLayoutEvent(size, 0) : makeLayoutEvent(0, size));
      }
    });
    return targets.length;
  }

  measureAllCells(heightForIndex: (index: number) => number): void {
    const cells = this.cellInstances();
    act(() => {
      for (const [index, cell] of cells) {
        const target = cell.findAll(
          (node) => node.type === View && node.props.onLayout != null,
        )[0];
        if (target != null) {
          target.props.onLayout(
            this.horizontal
              ? makeLayoutEvent(heightForIndex(index), 0)
              : makeLayoutEvent(0, heightForIndex(index)),
          );
        }
      }
    });
  }
}

export function webOnlyDependencyUsages(): ReadonlyArray<string> {
  return getWebOnlyDependencyUsagesForTests();
}

export function renderNitroList<T = string>(
  props: NitroListProps<T>,
  mirrorConfig?: HybridMirrorConfig,
): NitroListHarness<T> {
  clearMirrorsForTests();
  clearCreatedSharedValuesForTests();
  clearWebOnlyDependencyUsagesForTests();
  if (mirrorConfig != null) setMirrorConfigForTests(mirrorConfig);
  return new NitroListHarness<T>(props).mount();
}
