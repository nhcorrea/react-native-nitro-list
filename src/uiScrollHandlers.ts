import type {SharedValue} from 'react-native-reanimated';
import type {ReanimatedScrollEvent} from 'react-native-reanimated/lib/typescript/hook/commonTypes';
import {scheduleOnRN} from 'react-native-worklets';

import type {NitroListEngine} from './NitroListHost';
import {driveStickyOnUi} from './sticky';
import {VIEWABILITY_MIN_OFFSET_DELTA} from './viewability';

const UI_VIEWABILITY_MIN_INTERVAL_MS = 32;

export type UiScrollContext = {
  lastY?: number;
  lastTime?: number;
  velocity?: number;
  lastViewabilityY?: number;
  lastViewabilityTime?: number;
};

export interface UiScrollHandlerInputs {
  isHorizontal: boolean;
  engine: NitroListEngine | null;
  paddingTopSv: SharedValue<number>;
  scrollOffsetSv: SharedValue<number>;
  userScrollOffsetSv: SharedValue<number> | undefined;
  stickyIndices: ReadonlyArray<number>;
  stickyOffset: number;
  stickyTranslateYSv: SharedValue<number>;
  stickyIndexSv: SharedValue<number>;
  stickyOverlaySizeSv: SharedValue<number>;
  applyStickyIndex: (index: number) => void;
  hasViewabilityWakeups: boolean;
  settleViewabilityTick: (absoluteY: number) => void;
  onScrollWorklet: ((event: ReanimatedScrollEvent) => void) | undefined;
  hasUserOnScroll: boolean;
  emitUserScroll: (y: number) => void;
  settleEndDrag: (velocityDpS: number, absoluteY: number) => void;
}

export function createUiScrollHandlers(inputs: UiScrollHandlerInputs): {
  onScroll: (event: ReanimatedScrollEvent, ctx: UiScrollContext) => void;
  onEndDrag: (event: ReanimatedScrollEvent, ctx: UiScrollContext) => void;
} {
  const {
    isHorizontal,
    engine,
    paddingTopSv,
    scrollOffsetSv,
    userScrollOffsetSv,
    stickyIndices,
    stickyOffset,
    stickyTranslateYSv,
    stickyIndexSv,
    stickyOverlaySizeSv,
    applyStickyIndex,
    hasViewabilityWakeups,
    settleViewabilityTick,
    onScrollWorklet,
    hasUserOnScroll,
    emitUserScroll,
    settleEndDrag,
  } = inputs;
  const stickyCount = stickyIndices.length;
  return {
    onScroll: (event, ctx) => {
      'worklet';
      const y = isHorizontal ? event.contentOffset.x : event.contentOffset.y;
      const engineOffset = y - paddingTopSv.value;
      if (engine != null) {
        engine.setScrollOffset(engineOffset);
      }
      scrollOffsetSv.value = engineOffset;
      if (userScrollOffsetSv != null) {
        userScrollOffsetSv.value = y;
      }
      const now = Date.now();
      const lastTime = ctx.lastTime;
      const lastY = ctx.lastY;
      if (lastTime == null || lastY == null || now - lastTime > 200) {
        ctx.velocity = 0;
      } else if (now - lastTime >= 1) {
        ctx.velocity = ((y - lastY) / (now - lastTime)) * 1000;
      }
      ctx.lastY = y;
      ctx.lastTime = now;
      if (stickyCount > 0 && engine != null) {
        driveStickyOnUi(
          engine,
          engineOffset,
          stickyIndices,
          stickyOffset,
          stickyTranslateYSv,
          stickyIndexSv,
          stickyOverlaySizeSv,
          applyStickyIndex,
        );
      }
      if (hasViewabilityWakeups) {
        const lastVt = ctx.lastViewabilityTime;
        const lastVy = ctx.lastViewabilityY;
        if (
          lastVt == null ||
          lastVy == null ||
          (now - lastVt >= UI_VIEWABILITY_MIN_INTERVAL_MS &&
            Math.abs(y - lastVy) >= VIEWABILITY_MIN_OFFSET_DELTA)
        ) {
          ctx.lastViewabilityTime = now;
          ctx.lastViewabilityY = y;
          scheduleOnRN(settleViewabilityTick, y);
        }
      }
      if (onScrollWorklet != null) {
        onScrollWorklet(event);
      }
      if (hasUserOnScroll) {
        scheduleOnRN(emitUserScroll, y);
      }
    },
    onEndDrag: (event, ctx) => {
      'worklet';
      scheduleOnRN(
        settleEndDrag,
        ctx.velocity ?? 0,
        isHorizontal ? event.contentOffset.x : event.contentOffset.y,
      );
    },
  };
}
