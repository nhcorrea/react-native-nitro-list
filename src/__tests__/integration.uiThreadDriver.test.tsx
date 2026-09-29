import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {View, type LayoutChangeEvent} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import type {NitroListProps, NitroListRenderScrollComponentProps} from '../NitroList';
import {NitroList} from '../NitroList';
import {makeItems, itemKey} from './helpers/harness';
import {clearMirrorsForTests, getLastMirror} from './helpers/mockNitroListHost';

type Registration = {id: number; worklet: (event: unknown) => void; eventName: string; viewTag: number};

const mockRegistrations = new Map<number, Registration>();
const mockCounter = {next: 0};

jest.mock('react-native-reanimated/src/core', () => ({
  registerEventHandler: (worklet: (event: unknown) => void, eventName: string, viewTag: number) => {
    const id = ++mockCounter.next;
    mockRegistrations.set(id, {id, worklet, eventName, viewTag});
    return id;
  },
  unregisterEventHandler: (id: number) => {
    mockRegistrations.delete(id);
  },
}));

jest.mock('react-native-reanimated', () => {
  const base = jest.requireActual<typeof import('./helpers/mockReanimated')>('./helpers/mockReanimated');
  const {useEvent} = jest.requireActual<{
    useEvent: (handler: (event: unknown) => void, events: string[], rebuild: boolean) => unknown;
  }>('react-native-reanimated/src/hook/useEvent');
  return {
    ...base,
    __esModule: true,
    default: base.default,
    useAnimatedScrollHandler(handlers: {onScroll?: (event: unknown, ctx: Record<string, unknown>) => void}) {
      const {useRef: mockUseRef} = jest.requireActual<typeof import('react')>('react');
      const handlersRef = mockUseRef(handlers);
      handlersRef.current = handlers;
      const contextRef = mockUseRef<Record<string, unknown>>({});
      return useEvent((event) => handlersRef.current.onScroll?.(event, contextRef.current), ['onScroll'], true);
    },
  };
});

const {NativeEventsManager} = jest.requireActual<{
  NativeEventsManager: new (component: unknown) => {
    attachEvents(): void;
    detachEvents(): void;
    updateEvents(prevProps: unknown): void;
  };
}>('react-native-reanimated/src/createAnimatedComponent/NativeEventsManager');

const SCROLL_TAG = 42;

class RealEventsScrollView extends React.Component<Omit<NitroListRenderScrollComponentProps, 'ref'>> {
  _componentRef = {getScrollableNode: () => SCROLL_TAG};
  private manager!: InstanceType<typeof NativeEventsManager>;

  getComponentViewTag(): number {
    return SCROLL_TAG;
  }

  componentDidMount(): void {
    this.manager = new NativeEventsManager(this);
    this.manager.attachEvents();
  }

  componentDidUpdate(prevProps: Omit<NitroListRenderScrollComponentProps, 'ref'>): void {
    this.manager.updateEvents(prevProps);
  }

  componentWillUnmount(): void {
    this.manager.detachEvents();
  }

  render(): React.ReactNode {
    return <View>{this.props.children}</View>;
  }
}

let renderer: ReactTestRenderer | undefined;
let scrollProps!: NitroListRenderScrollComponentProps;
const fakeScrollRef = {scrollTo: () => {}, getScrollableNode: () => SCROLL_TAG};

function renderScrollComponent({ref, ...rest}: NitroListRenderScrollComponentProps) {
  scrollProps = {ref, ...rest};
  const refObject = ref as unknown as {current: unknown} | null;
  if (refObject != null && typeof refObject === 'object') refObject.current = fakeScrollRef;
  return <RealEventsScrollView {...rest} />;
}

function element(props: Partial<NitroListProps<string>>) {
  return (
    <NitroList<string>
      data={makeItems(500)}
      estimatedItemSize={100}
      keyExtractor={itemKey}
      renderItem={() => null}
      renderScrollComponent={renderScrollComponent}
      {...props}
    />
  );
}

function scrollWorklets(): Registration[] {
  return Array.from(mockRegistrations.values()).filter(
    (registration) => registration.viewTag === SCROLL_TAG && registration.eventName === 'onScroll',
  );
}

function nativeScroll(y: number): void {
  act(() => {
    const event = {contentOffset: {x: 0, y}, eventName: 'onScroll'};
    for (const registration of scrollWorklets()) registration.worklet(event);
    if (typeof scrollProps.onScroll === 'function') {
      (scrollProps.onScroll as (event: unknown) => void)({nativeEvent: event});
    }
  });
}

function layout(width: number, height: number): void {
  act(() => {
    scrollProps.onLayout({nativeEvent: {layout: {x: 0, y: 0, width, height}}} as LayoutChangeEvent);
  });
}

async function settle(ms = 50): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockRegistrations.clear();
  clearMirrorsForTests();
});

afterEach(() => {
  if (renderer != null) act(() => renderer!.unmount());
  renderer = undefined;
  jest.useRealTimers();
});

describe('UI-thread scroll driver (fronteira 1.3)', () => {
  it('registers the scroll worklet when the list mounts in UI-thread mode', async () => {
    act(() => {
      renderer = create(element({experimentalUiThreadScroll: true}));
    });
    layout(400, 800);
    await settle();

    expect(scrollWorklets()).toHaveLength(1);
    expect(typeof scrollProps.onScroll).not.toBe('function');
    const mirror = getLastMirror();
    mirror.callLog.length = 0;
    nativeScroll(20000);
    await settle();
    expect(mirror.callLog).toContain('setScrollOffset');
    expect(mirror.core.getEngagedRange(20000, 800, 250).start).toBeGreaterThan(150);
  });

  it('moves between the JS and UI drivers when the mode is toggled on a custom scroll component', async () => {
    act(() => {
      renderer = create(element({experimentalUiThreadScroll: false}));
    });
    layout(400, 800);
    await settle();
    expect(scrollWorklets()).toHaveLength(0);
    expect(typeof scrollProps.onScroll).toBe('function');
    nativeScroll(3000);
    await settle();

    act(() => renderer!.update(element({experimentalUiThreadScroll: true})));
    await settle();
    expect(scrollWorklets()).toHaveLength(1);
    expect(typeof scrollProps.onScroll).not.toBe('function');
    expect(scrollProps.contentOffset).toEqual({x: 0, y: 3000});

    act(() => renderer!.update(element({experimentalUiThreadScroll: false})));
    await settle();
    expect(scrollWorklets()).toHaveLength(0);
    expect(typeof scrollProps.onScroll).toBe('function');
  });
});
