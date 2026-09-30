import type {SharedValue} from 'react-native-reanimated';
import {scheduleOnRN} from 'react-native-worklets';

import type {NitroListEngine} from './NitroListHost';

export type StickyComputeResult = {index: number; translateY: number; height: number};
export type StickyLayoutReader = {
  getItemOffset: (index: number) => number;
  getItemSize: (index: number) => number;
};

export function createStickyResult(): StickyComputeResult {
  'worklet';
  return {index: -1, translateY: 0, height: 0};
}

export function computeSticky(
  scrollOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  reader: StickyLayoutReader,
  overlaySize: number,
  out: StickyComputeResult,
): StickyComputeResult {
  'worklet';
  const bar = scrollOffset + stickyOffset;
  let activeK = -1;
  let lo = 0;
  let hi = stickyIndices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (reader.getItemOffset(stickyIndices[mid]) <= bar) {
      activeK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (activeK === -1) {
    out.index = -1;
    out.translateY = stickyOffset;
    out.height = 0;
    return out;
  }
  const idx = stickyIndices[activeK];
  const h = overlaySize > 0 ? overlaySize : reader.getItemSize(idx);
  let translateY = stickyOffset;
  const nextK = activeK + 1;
  if (nextK < stickyIndices.length) {
    const nextNaturalY = reader.getItemOffset(stickyIndices[nextK]) - scrollOffset;
    if (nextNaturalY < stickyOffset + h) {
      translateY = nextNaturalY - h;
    }
  }
  out.index = idx;
  out.translateY = translateY;
  out.height = h;
  return out;
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
    hybrid,
    overlaySizeSv.value,
    createStickyResult(),
  );
  if (translateYSv.value !== result.translateY) {
    translateYSv.value = result.translateY;
  }
  if (activeIndexSv.value !== result.index) {
    activeIndexSv.value = result.index;
    scheduleOnRN(notifyIndexChange, result.index);
  }
}

