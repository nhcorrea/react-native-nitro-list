import {describe, expect, it} from '@jest/globals';

import {pendingCorrectionShift, scrollEventTimestamp, type PendingScrollCorrection} from '../scrollCorrections';

function pending(delta: number, sequence: number, createdAt = 0): PendingScrollCorrection {
  return {delta, sequence, appliedAt: -1, createdAt};
}

describe('pendingCorrectionShift', () => {
  it('moves an event emitted before the correction mounted into the corrected frame', () => {
    const queue = [pending(2918.5, 7)];
    expect(pendingCorrectionShift(queue, 1000, 10, () => -1)).toBe(2918.5);
    expect(queue).toHaveLength(1);
  });

  it('keeps shifting events older than the mount that applied the correction', () => {
    const queue = [pending(-40, 3)];
    expect(pendingCorrectionShift(queue, 1990, 10, (sequence) => (sequence <= 3 ? 2000 : -1))).toBe(-40);
    expect(queue[0].appliedAt).toBe(2000);
    expect(queue).toHaveLength(1);
  });

  it('drops the correction once an event from the mount or later arrives', () => {
    const queue = [pending(120, 4)];
    expect(pendingCorrectionShift(queue, 2000, 10, () => 2000)).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('sums only the corrections still pending at the event time', () => {
    const queue = [pending(10, 1), pending(25, 2)];
    const mountedAt = (sequence: number) => (sequence === 1 ? 500 : -1);
    expect(pendingCorrectionShift(queue, 600, 10, mountedAt)).toBe(25);
    expect(queue.map((entry) => entry.sequence)).toEqual([2]);
  });

  it('expires a correction that never reaches a mount', () => {
    const queue = [pending(30, 9, 0)];
    expect(pendingCorrectionShift(queue, 100, 2000, () => -1, 1000)).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('treats an applied correction as already in an event without a timestamp', () => {
    const queue = [pending(30, 9)];
    expect(pendingCorrectionShift(queue, undefined, 10, () => 5)).toBe(0);
  });
});

describe('scrollEventTimestamp', () => {
  it('reads the native timestamp only when it is a finite number', () => {
    expect(scrollEventTimestamp({timestamp: 1234})).toBe(1234);
    expect(scrollEventTimestamp({timestamp: '1234'})).toBeUndefined();
    expect(scrollEventTimestamp({})).toBeUndefined();
  });
});
