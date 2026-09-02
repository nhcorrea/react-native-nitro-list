import React from 'react';
import {StyleSheet, type StyleProp, type ViewStyle} from 'react-native';

export function readNumericPadding(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function extractAxisPadding(
  style: StyleProp<ViewStyle>,
  horizontal: boolean,
): {start: number; end: number} {
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  if (!flat) return {start: 0, end: 0};
  const fallback = readNumericPadding(flat.padding);
  if (horizontal) {
    const axis =
      flat.paddingHorizontal != null ? readNumericPadding(flat.paddingHorizontal) : fallback;
    const start = flat.paddingStart ?? flat.paddingLeft;
    const end = flat.paddingEnd ?? flat.paddingRight;
    return {
      start: start != null ? readNumericPadding(start) : axis,
      end: end != null ? readNumericPadding(end) : axis,
    };
  }
  const axis = flat.paddingVertical != null ? readNumericPadding(flat.paddingVertical) : fallback;
  return {
    start: flat.paddingTop != null ? readNumericPadding(flat.paddingTop) : axis,
    end: flat.paddingBottom != null ? readNumericPadding(flat.paddingBottom) : axis,
  };
}

export function renderSlot(
  Slot: React.ComponentType<unknown> | React.ReactElement | null | undefined,
): React.ReactElement | null {
  if (Slot == null) return null;
  return React.isValidElement(Slot) ? Slot : React.createElement(Slot);
}

