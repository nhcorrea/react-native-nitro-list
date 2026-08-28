import React, {useRef} from 'react';
import {ScrollView, View, type ScrollViewProps, type ViewProps} from 'react-native';

export type SharedValue<T> = {value: T};

const createdSharedValues: Array<SharedValue<unknown>> = [];

export function getCreatedSharedValuesForTests(): ReadonlyArray<SharedValue<unknown>> {
  return createdSharedValues;
}

export function clearCreatedSharedValuesForTests(): void {
  createdSharedValues.length = 0;
}

const webOnlyDependencyUsages: string[] = [];

export function getWebOnlyDependencyUsagesForTests(): ReadonlyArray<string> {
  return webOnlyDependencyUsages;
}

export function clearWebOnlyDependencyUsagesForTests(): void {
  webOnlyDependencyUsages.length = 0;
}

function noteDependencies(hook: string, deps: unknown): void {
  if (deps !== undefined) webOnlyDependencyUsages.push(hook);
}

export function useSharedValue<T>(initial: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  if (ref.current == null) {
    ref.current = {value: initial};
    createdSharedValues.push(ref.current as SharedValue<unknown>);
  }
  return ref.current;
}

export function useAnimatedStyle<T>(factory: () => T, deps?: ReadonlyArray<unknown>): T {
  noteDependencies('useAnimatedStyle', deps);
  return factory();
}

export function useDerivedValue<T>(factory: () => T, deps?: ReadonlyArray<unknown>): SharedValue<T> {
  noteDependencies('useDerivedValue', deps);
  const ref = useRef<SharedValue<T> | null>(null);
  if (ref.current == null) ref.current = {value: factory()};
  else ref.current.value = factory();
  return ref.current;
}

export function useAnimatedReaction<T>(
  _prepare: () => T,
  _react: (current: T, previous: T | null) => void,
  deps?: ReadonlyArray<unknown>,
): void {
  noteDependencies('useAnimatedReaction', deps);
}

type ScrollHandlers = {
  onScroll?: (event: unknown, context: Record<string, unknown>) => void;
  onBeginDrag?: (event: unknown, context: Record<string, unknown>) => void;
  onEndDrag?: (event: unknown, context: Record<string, unknown>) => void;
  onMomentumBegin?: (event: unknown, context: Record<string, unknown>) => void;
  onMomentumEnd?: (event: unknown, context: Record<string, unknown>) => void;
};

export function useAnimatedScrollHandler(
  handlers: ScrollHandlers,
  deps?: ReadonlyArray<unknown>,
): (event: {nativeEvent?: unknown}) => void {
  noteDependencies('useAnimatedScrollHandler', deps);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const contextRef = useRef<Record<string, unknown>>({});
  const dispatchRef = useRef<((event: {nativeEvent?: unknown}) => void) | null>(null);
  if (dispatchRef.current == null) {
    dispatchRef.current = (event) => {
      handlersRef.current.onScroll?.(event.nativeEvent ?? event, contextRef.current);
    };
  }
  return dispatchRef.current;
}

const AnimatedScrollView = React.forwardRef<ScrollView, ScrollViewProps>(
  function AnimatedScrollView(props, ref) {
    return <ScrollView ref={ref} {...props} />;
  },
);

function AnimatedView(props: ViewProps) {
  return <View {...props} />;
}

const Animated = {
  ScrollView: AnimatedScrollView,
  View: AnimatedView,
};

export default Animated;
