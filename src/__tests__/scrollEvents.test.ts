import {describe, expect, it} from '@jest/globals';

import {
  classifyScrollEcho,
  classifyScrollEvent,
  noteScrollCommand,
  type NitroListScrollCommandEcho,
} from '../scrollEvents';

describe('classifyScrollEvent', () => {
  it('classifies ordinary deltas as user scrolls', () => {
    expect(classifyScrollEvent(100, 80, 600, false)).toBe('user');
    expect(classifyScrollEvent(80, 100, 600, false)).toBe('user');
    expect(classifyScrollEvent(700, 100, 600, false)).toBe('user');
  });

  it('classifies deltas beyond one viewport as large jumps', () => {
    expect(classifyScrollEvent(701, 100, 600, false)).toBe('large-jump');
    expect(classifyScrollEvent(100, 5000, 600, false)).toBe('large-jump');
  });

  it('programmatic animated scrolling wins over the large-jump heuristic', () => {
    expect(classifyScrollEvent(5000, 100, 600, true)).toBe('programmatic');
    expect(classifyScrollEvent(120, 100, 600, true)).toBe('programmatic');
  });

  it('never reports large jumps without a measured viewport', () => {
    expect(classifyScrollEvent(5000, 100, 0, false)).toBe('user');
  });
});

const EPS = 0.5;
const MAX_AGE = 250;

function command(
  from: number,
  target: number,
  time: number,
  staleOffset: number | null = null,
): NitroListScrollCommandEcho {
  return {from, target, time, staleOffset};
}

describe('classifyScrollEcho', () => {
  it('has no opinion without a command in flight', () => {
    expect(classifyScrollEcho(100, null, 0, EPS, MAX_AGE)).toBe('none');
  });

  it('treats an echo that lags the target as stale', () => {
    expect(classifyScrollEcho(66, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('stale');
    expect(classifyScrollEcho(80, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('stale');
  });

  it('resolves once the echo lands on the target', () => {
    expect(classifyScrollEcho(99, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('resolved');
    expect(classifyScrollEcho(98.6, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('resolved');
  });

  it('resolves when the scroll goes somewhere the command never travels', () => {
    expect(classifyScrollEcho(120, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('resolved');
    expect(classifyScrollEcho(40, command(66, 99, 1000), 1008, EPS, MAX_AGE)).toBe('resolved');
  });

  it('resolves when two echoes in a row report the same position', () => {
    expect(classifyScrollEcho(80, command(66, 99, 1000, 80), 1008, EPS, MAX_AGE)).toBe(
      'resolved',
    );
  });

  it('resolves once the command is older than the echo window', () => {
    expect(classifyScrollEcho(80, command(66, 99, 1000), 1400, EPS, MAX_AGE)).toBe('resolved');
  });

  it('works backwards too', () => {
    expect(classifyScrollEcho(99, command(99, 66, 1000), 1008, EPS, MAX_AGE)).toBe('stale');
    expect(classifyScrollEcho(66, command(99, 66, 1000), 1008, EPS, MAX_AGE)).toBe('resolved');
  });
});

describe('noteScrollCommand', () => {
  it('keeps the burst origin while commands keep coming', () => {
    let pending = noteScrollCommand(null, 0, 33, 1000, MAX_AGE);
    pending = noteScrollCommand(pending, 33, 66, 1016, MAX_AGE);
    pending = noteScrollCommand(pending, 66, 99, 1032, MAX_AGE);
    expect(pending.from).toBe(0);
    expect(pending.target).toBe(99);
    expect(classifyScrollEcho(33, pending, 1040, EPS, MAX_AGE)).toBe('stale');
  });

  it('restarts the burst after the echo window closes', () => {
    const pending = noteScrollCommand(null, 0, 33, 1000, MAX_AGE);
    const next = noteScrollCommand(pending, 500, 533, 2000, MAX_AGE);
    expect(next.from).toBe(500);
    expect(next.staleOffset).toBeNull();
  });

  it('forgets a stale echo when the burst restarts', () => {
    const pending = noteScrollCommand(null, 0, 33, 1000, MAX_AGE);
    pending.staleOffset = 10;
    const live = noteScrollCommand(pending, 33, 66, 1016, MAX_AGE);
    expect(live.staleOffset).toBe(10);
    const restarted = noteScrollCommand(pending, 33, 66, 1400, MAX_AGE);
    expect(restarted.staleOffset).toBeNull();
  });
});
