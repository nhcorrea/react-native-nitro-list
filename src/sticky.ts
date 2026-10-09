import type {SharedValue} from 'react-native-reanimated';
import {scheduleOnRN} from 'react-native-worklets';

import type {NitroListEngine} from './NitroListHost';
import {computeSticky, createStickyResult} from './stickyCompute';

export {computeSticky, createStickyResult, type StickyComputeResult, type StickyLayoutReader} from './stickyCompute';

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

