import type {SharedValue} from 'react-native-reanimated';
import {scheduleOnRN} from 'react-native-worklets';

import type {NitroListEngine} from './NitroListHost';

export type StickyComputeResult = {index: number; translateY: number; height: number};
export type LayoutReader = (index: number) => number;

export function computeSticky(
  scrollOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  readOffset: LayoutReader,
  readSize: LayoutReader,
  overlaySize: number,
): StickyComputeResult {
  'worklet';
  const bar = scrollOffset + stickyOffset;
  let activeK = -1;
  let lo = 0;
  let hi = stickyIndices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (readOffset(stickyIndices[mid]) <= bar) {
      activeK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (activeK === -1) {
    return {index: -1, translateY: stickyOffset, height: 0};
  }
  const idx = stickyIndices[activeK];
  const h = overlaySize > 0 ? overlaySize : readSize(idx);
  let translateY = stickyOffset;
  const nextK = activeK + 1;
  if (nextK < stickyIndices.length) {
    const nextNaturalY = readOffset(stickyIndices[nextK]) - scrollOffset;
    if (nextNaturalY < stickyOffset + h) {
      translateY = nextNaturalY - h;
    }
  }
  return {index: idx, translateY, height: h};
}

export function driveStickyOnUi(
  hybrid: NitroListEngine,
  engineOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  translateYSv: SharedValue<number>,
  activeIndexSv: SharedValue<number>,
  overlaySizeSv: SharedValue<number>,
  notifyIndexChange: (index: number) => void,
): void {
  'worklet';
  const result = computeSticky(
    engineOffset,
    stickyIndices,
    stickyOffset,
    (i: number) => hybrid.getItemOffset(i),
    (i: number) => hybrid.getItemSize(i),
    overlaySizeSv.value,
  );
  if (translateYSv.value !== result.translateY) {
    translateYSv.value = result.translateY;
  }
  if (activeIndexSv.value !== result.index) {
    activeIndexSv.value = result.index;
    scheduleOnRN(notifyIndexChange, result.index);
  }
}

