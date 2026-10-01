import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import type {NitroListProps} from '../NitroList';
import {NitroListPerfMonitor} from '../PerfMonitor';
import {NitroListBenchmarkScreen} from '../dev/NitroListBenchmarkScreen';

type Item = {text: string; height: number};
let mockListProps: NitroListProps<Item>;
const mockScrollToEnd = jest.fn<() => Promise<void>>();

jest.mock('../NitroList', () => {
  const React = require('react');
  const {View} = require('react-native');
  return {
    NitroList: React.forwardRef((props: NitroListProps<Item>, ref: React.Ref<unknown>) => {
      mockListProps = props;
      React.useImperativeHandle(ref, () => ({scrollToEnd: mockScrollToEnd}));
      return React.createElement(View);
    }),
  };
});

describe('stream benchmark measurement window', () => {
  let renderer: ReactTestRenderer | undefined;
  let resolveLanding: () => void;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let buttonRenders = 0;

  async function press(label: string): Promise<void> {
    const text = renderer!.root.findAllByProps({children: label})[0];
    let button = text?.parent;
    while (button != null && typeof button.props.onPress !== 'function') button = button.parent;
    expect(button).toBeDefined();
    await act(async () => { button!.props.onPress(); });
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const native = require('react-native') as typeof import('react-native');
    const NativePressable = native.Pressable;
    function CountedPressable(props: React.ComponentProps<typeof NativePressable>) {
      buttonRenders++;
      return React.createElement(NativePressable, props);
    }
    buttonRenders = 0;
    jest.spyOn(native as {Pressable: unknown}, 'Pressable', 'get').mockReturnValue(CountedPressable);
    mockScrollToEnd.mockReset();
    mockScrollToEnd.mockImplementation(() => new Promise<void>((resolve) => {
      resolveLanding = resolve;
    }));
    act(() => { renderer = create(<NitroListBenchmarkScreen />); });
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    NitroListPerfMonitor.disable();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts tokens and counters after the anchored chat commits and landing settles', async () => {
    await press('chat-5k');
    const initialText = mockListProps.data![4_999].text;
    await press('chat-stream');
    expect(mockScrollToEnd).toHaveBeenCalledTimes(1);
    expect(mockListProps.maintainScrollAtEnd).toBe(true);
    expect(mockListProps.anchoredEndSpace?.anchorIndex).toBe(4_999);

    NitroListPerfMonitor.recordItemMount();
    NitroListPerfMonitor.recordScrollToIndexComplete({
      durationMs: 100, correctionPasses: 1, prewarmRestarts: 0, animated: false,
    });
    await advance(1_000);
    expect(mockListProps.data![4_999].text).toBe(initialText);

    await act(async () => { resolveLanding(); });
    await advance(500);
    expect(NitroListPerfMonitor.getSnapshot().itemMounts).toBe(0);
    expect(NitroListPerfMonitor.getSnapshot().lastScrollToIndex).toBeNull();
    NitroListPerfMonitor.recordItemMount();
    await advance(30_050);

    const call = logSpy.mock.calls.find(([tag]) => tag === '[NitroListBenchmark]');
    expect(call).toBeDefined();
    const report = JSON.parse(call![1] as string);
    expect(report.setupMs).toBe(1_500);
    expect(report.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(report.durationMs).toBeLessThan(30_050);
    expect(report.streamUpdates).toBeGreaterThanOrEqual(599);
    expect(report.streamUpdates).toBeLessThanOrEqual(600);
    expect(report.perf.itemMounts).toBe(1);
    expect(report.perf.lastScrollToIndex).toBeNull();
    expect(mockListProps.maintainScrollAtEnd).toBe(false);
  });

  it('does not start tokens or publish a measured run when stopped during preparation', async () => {
    await press('chat-5k');
    const initialText = mockListProps.data![4_999].text;
    await press('chat-stream');
    await press('Stop');
    await act(async () => { resolveLanding(); });
    await advance(1_000);

    expect(mockListProps.data![4_999].text).toBe(initialText);
    expect(mockListProps.maintainScrollAtEnd).toBe(false);
    expect(logSpy.mock.calls.some(([tag]) => tag === '[NitroListBenchmark]')).toBe(false);
  });

  it('updates the streamed row without rendering the benchmark buttons for every token', async () => {
    await press('chat-5k');
    await press('chat-stream');
    await act(async () => { resolveLanding(); });
    await advance(500);
    const initialText = mockListProps.data![4_999].text;
    const before = buttonRenders;

    await advance(50);
    expect(mockListProps.data![4_999].text).not.toBe(initialText);
    expect(buttonRenders).toBe(before);

    await advance(450);
    expect(buttonRenders).toBeGreaterThan(before); // The next HUD snapshot still updates the panel.
    await press('Stop');
    await advance(50);
    expect(mockListProps.maintainScrollAtEnd).toBe(false);
  });
});
