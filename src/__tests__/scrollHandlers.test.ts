import {describe, expect, it, jest} from '@jest/globals';
import type {NativeSyntheticEvent, NativeScrollEvent} from 'react-native';

import {createScrollHandlers, type ScrollHandlersCtx} from '../scrollHandlers';
import {createVelocityRing} from '../scrollVelocity';

function makeContext(offset: number, deferIdleReserve: () => void): ScrollHandlersCtx {
  return {
    correctionShift: () => 0,
    deferIdleReserve,
    effectivePaddingStartRef: {current: 0},
    isHorizontalRef: {current: false},
    lastPushedEngineOffsetRef: {current: offset},
    lastScrollOffsetRef: {current: offset},
    latestRangeRef: {current: {start: 0, end: 9}},
    mainViewportRef: {current: 500},
    pendingScrollCommandRef: {current: null},
    pendingSizesRef: {current: {count: 0}},
    isPrewarmingRangeRef: {current: false},
    programmaticAnimatedScrollSeenRef: {current: false},
    scrollActivityRef: {current: {dragging: false, momentum: false, programmaticAnimated: false, pendingAdjust: 0}},
    scrollVelocityRef: {current: {offset, time: 0, velocity: 0}},
    uiThreadDriverActiveRef: {current: false},
    velocityRingRef: {current: createVelocityRing()},
    applyScrollOffsetSync: () => {},
    captureMvcpAnchor: () => {},
    checkEdgeCallbacksRef: {current: () => {}},
    emitFirstVisibleRef: {current: () => {}},
    evaluateViewabilityRef: {current: () => {}},
    noteVelocityForAdaptive: () => {},
    updateSticky: () => {},
  } as unknown as ScrollHandlersCtx;
}

function scrollEvent(y: number): NativeSyntheticEvent<NativeScrollEvent> {
  return {nativeEvent: {contentOffset: {x: 0, y}}} as NativeSyntheticEvent<NativeScrollEvent>;
}

describe('handleOuterScroll — idle reserve', () => {
  it('defers pending idle work only when the corrected offset changes', () => {
    const deferIdleReserve = jest.fn();
    const ctx = makeContext(20, deferIdleReserve);
    const handlers = createScrollHandlers(ctx);

    handlers.handleOuterScroll(scrollEvent(20));
    expect(deferIdleReserve).not.toHaveBeenCalled();

    handlers.handleOuterScroll(scrollEvent(36));
    expect(deferIdleReserve).toHaveBeenCalledTimes(1);
    expect(ctx.lastScrollOffsetRef.current).toBe(36);
  });
});
