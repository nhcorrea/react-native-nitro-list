import React, {forwardRef, useCallback, useImperativeHandle, useMemo, useRef} from 'react';
import {StyleSheet, type ScrollView} from 'react-native';
import {useSharedValue, type SharedValue} from 'react-native-reanimated';

import {NitroList} from '../NitroList';
import type {
  NitroListAnchoredEndSpaceConfig,
  NitroListHandle,
  NitroListProps,
  NitroListRenderScrollComponent,
} from '../NitroList';
import {warnDevOnce} from '../devWarnings';

type KeyboardControllerModule = typeof import('react-native-keyboard-controller');

let keyboardControllerModule: KeyboardControllerModule | null = null;
try {
  keyboardControllerModule = require('react-native-keyboard-controller');
} catch {
  keyboardControllerModule = null;
}

export function getKeyboardControllerModule(): KeyboardControllerModule | null {
  return keyboardControllerModule;
}

export type KeyboardLiftBehavior = 'always' | 'whenAtEnd' | 'persistent' | 'never';

export type KeyboardAwareNitroListProps<T> = NitroListProps<T> & {
  keyboardOffset?: number;
  keyboardLiftBehavior?: KeyboardLiftBehavior;
  extraContentPadding?: SharedValue<number>;
  keyboardFreeze?: boolean | SharedValue<boolean>;
};

function KeyboardAwareNitroListInner<T>(
  props: KeyboardAwareNitroListProps<T>,
  ref: React.Ref<NitroListHandle>,
) {
  const {
    keyboardOffset,
    keyboardLiftBehavior,
    extraContentPadding,
    keyboardFreeze,
    anchoredEndSpace,
    ...listProps
  } = props;

  const listRef = useRef<NitroListHandle | null>(null);
  useImperativeHandle(ref, () => listRef.current as NitroListHandle, []);

  const blankSpace = useSharedValue(0);
  const userOnSizeChangedRef = useRef(anchoredEndSpace?.onSizeChanged);
  userOnSizeChangedRef.current = anchoredEndSpace?.onSizeChanged;

  const wiredAnchored = useMemo<NitroListAnchoredEndSpaceConfig | undefined>(() => {
    if (anchoredEndSpace == null) return undefined;
    return {
      ...anchoredEndSpace,
      onSizeChanged: (size: number) => {
        blankSpace.value = size;
        userOnSizeChangedRef.current?.(size);
      },
    };
  }, [anchoredEndSpace, blankSpace]);

  const handleContentInsetChange = useCallback(
    (insets: {top: number; bottom: number; left: number; right: number}) => {
      listRef.current?.reportContentInset({bottom: insets.bottom});
    },
    [],
  );

  const renderScrollComponent = useMemo<NitroListRenderScrollComponent | undefined>(() => {
    const module = keyboardControllerModule;
    if (module == null) return undefined;
    const ChatScrollView = module.KeyboardChatScrollView;
    return ({ref: scrollRef, children, ...scrollProps}) => (
      <ChatScrollView
        ref={scrollRef as React.Ref<ScrollView>}
        style={StyleSheet.absoluteFill}
        offset={keyboardOffset}
        keyboardLiftBehavior={keyboardLiftBehavior}
        extraContentPadding={extraContentPadding}
        freeze={keyboardFreeze}
        blankSpace={blankSpace}
        onContentInsetChange={handleContentInsetChange}
        {...scrollProps}>
        {children}
      </ChatScrollView>
    );
  }, [
    keyboardOffset,
    keyboardLiftBehavior,
    extraContentPadding,
    keyboardFreeze,
    blankSpace,
    handleContentInsetChange,
  ]);

  if (keyboardControllerModule == null) {
    warnDevOnce(
      'keyboard-controller-missing',
      'KeyboardAwareNitroList needs the optional peer dependency ' +
        '"react-native-keyboard-controller" (>= 1.21.7). Install it to get keyboard-aware ' +
        'behavior — rendering a plain NitroList meanwhile.',
    );
    return <NitroList<T> {...listProps} ref={listRef} anchoredEndSpace={wiredAnchored} />;
  }

  return (
    <NitroList<T>
      {...listProps}
      ref={listRef}
      anchoredEndSpace={wiredAnchored}
      renderScrollComponent={renderScrollComponent}
    />
  );
}

export const KeyboardAwareNitroList = forwardRef(KeyboardAwareNitroListInner) as <T>(
  props: KeyboardAwareNitroListProps<T> & {ref?: React.Ref<NitroListHandle>},
) => React.ReactElement | null;

export function useKeyboardScrollToEnd(
  listRef: React.RefObject<NitroListHandle | null>,
): (animated?: boolean) => Promise<void> {
  return useCallback(
    async (animated: boolean = true) => {
      const dismiss =
        keyboardControllerModule != null
          ? keyboardControllerModule.KeyboardController.dismiss()
          : Promise.resolve();
      const scroll = listRef.current?.scrollToEnd(animated) ?? Promise.resolve();
      await Promise.all([dismiss, scroll]);
    },
    [listRef],
  );
}
