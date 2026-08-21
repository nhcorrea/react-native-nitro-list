import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React, {createRef} from 'react';
import {View, type LayoutChangeEvent} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import type {NitroListHandle} from '../NitroList';
import {clearMirrorsForTests} from './helpers/mockNitroListHost';
import {makeItems, itemKey} from './helpers/harness';

type CapturedChatProps = {
  blankSpace?: {value: number};
  onContentInsetChange?: (insets: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  children?: React.ReactNode;
  offset?: number;
  keyboardLiftBehavior?: string;
};

jest.mock('react-native-keyboard-controller', () => {
  const ReactLib = require('react') as typeof React;
  const RN = require('react-native') as typeof import('react-native');
  const captured: {props: CapturedChatProps | null} = {props: null};
  const KeyboardChatScrollView = ReactLib.forwardRef(function MockChatScrollView(
    props: CapturedChatProps,
    ref: React.Ref<unknown>,
  ) {
    captured.props = props;
    ReactLib.useImperativeHandle(ref, () => ({scrollTo: () => {}}));
    return ReactLib.createElement(RN.View, {testID: 'chat-scroll-view'}, props.children);
  });
  return {
    __captured: captured,
    KeyboardChatScrollView,
    KeyboardController: {dismiss: jest.fn(() => Promise.resolve())},
  };
});

import {
  KeyboardAwareNitroList,
  useKeyboardScrollToEnd,
} from '../keyboard';

function getCaptured(): CapturedChatProps {
  const module = require('react-native-keyboard-controller') as {
    __captured: {props: CapturedChatProps | null};
  };
  if (module.__captured.props == null) throw new Error('ChatScrollView never rendered');
  return module.__captured.props;
}

function getDismissMock(): jest.Mock {
  const module = require('react-native-keyboard-controller') as {
    KeyboardController: {dismiss: jest.Mock};
  };
  return module.KeyboardController.dismiss;
}

describe('keyboard entry point (T27)', () => {
  let renderer: ReactTestRenderer;
  let warnSpy: ReturnType<typeof jest.spyOn>;

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

  it('renders through KeyboardChatScrollView and feeds anchoredEndSpace into blankSpace', async () => {
    const ref = createRef<NitroListHandle>();
    act(() => {
      renderer = create(
        <KeyboardAwareNitroList<string>
          ref={ref}
          data={makeItems(20)}
          renderItem={() => null}
          estimatedItemSize={100}
          keyExtractor={itemKey}
          keyboardOffset={24}
          keyboardLiftBehavior="whenAtEnd"
          anchoredEndSpace={{anchorIndex: 18}}
        />,
      );
    });

    expect(renderer.root.findAllByProps({testID: 'chat-scroll-view'}).length).toBeGreaterThan(0);
    const chatProps = getCaptured();
    expect(chatProps.offset).toBe(24);
    expect(chatProps.keyboardLiftBehavior).toBe('whenAtEnd');

    act(() => {
      chatProps.onLayout?.({
        nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 600}},
      } as LayoutChangeEvent);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });

    expect(getCaptured().blankSpace?.value).toBe(400);
  });

  it('routes onContentInsetChange into reportContentInset so scrollToEnd targets deeper', async () => {
    const ref = createRef<NitroListHandle>();
    act(() => {
      renderer = create(
        <KeyboardAwareNitroList<string>
          ref={ref}
          data={makeItems(30)}
          renderItem={() => null}
          estimatedItemSize={100}
          keyExtractor={itemKey}
        />,
      );
    });
    const chatProps = getCaptured();
    act(() => {
      chatProps.onLayout?.({
        nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 600}},
      } as LayoutChangeEvent);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });

    act(() => {
      getCaptured().onContentInsetChange?.({top: 0, bottom: 250, left: 0, right: 0});
    });

    await act(async () => {
      const promise = ref.current?.scrollToEnd(false);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    expect(ref.current?.getAbsoluteLastScrollOffset()).toBeCloseTo(30 * 100 - 600 + 250, 0);
  });

  it('useKeyboardScrollToEnd dismisses the keyboard and scrolls in parallel', async () => {
    const ref = createRef<NitroListHandle>();
    let trigger: ((animated?: boolean) => Promise<void>) | null = null;
    function Probe() {
      trigger = useKeyboardScrollToEnd(ref);
      return null;
    }
    act(() => {
      renderer = create(
        <View>
          <KeyboardAwareNitroList<string>
            ref={ref}
            data={makeItems(30)}
            renderItem={() => null}
            estimatedItemSize={100}
            keyExtractor={itemKey}
          />
          <Probe />
        </View>,
      );
    });
    const chatProps = getCaptured();
    act(() => {
      chatProps.onLayout?.({
        nativeEvent: {layout: {x: 0, y: 0, width: 400, height: 600}},
      } as LayoutChangeEvent);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });

    await act(async () => {
      const promise = trigger?.(false);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
    });
    expect(getDismissMock()).toHaveBeenCalled();
    expect(ref.current?.getAbsoluteLastScrollOffset()).toBeCloseTo(30 * 100 - 600, 0);
  });
});
