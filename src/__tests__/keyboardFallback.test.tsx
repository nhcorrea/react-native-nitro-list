import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

import {clearWarnDevOnceForTests} from '../devWarnings';
import {clearMirrorsForTests} from './helpers/mockNitroListHost';
import {itemKey, makeItems} from './helpers/harness';

jest.mock('react-native-keyboard-controller', () => {
  throw new Error('module not installed');
});

import {KeyboardAwareNitroList} from '../keyboard';

describe('keyboard entry point without the optional peer', () => {
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

  it('warns once and degrades to a plain NitroList', () => {
    act(() => {
      renderer = create(
        <KeyboardAwareNitroList<string>
          data={makeItems(10)}
          renderItem={() => null}
          estimatedItemSize={100}
          keyExtractor={itemKey}
        />,
      );
    });
    expect(renderer.toJSON()).not.toBeNull();
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('react-native-keyboard-controller'),
      ),
    ).toBe(true);
  });
});
