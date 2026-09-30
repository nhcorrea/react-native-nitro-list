import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {waitForEventOrLayoutPass} from '../scrollCommands';

describe('waitForEventOrLayoutPass', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('removes its waiter when the layout pass wins', async () => {
    const waiters: Array<() => void> = [];
    const results: string[] = [];
    for (let k = 0; k < 20; k++) {
      const pending = waitForEventOrLayoutPass(waiters);
      await jest.advanceTimersByTimeAsync(64);
      results.push(await pending);
    }
    expect(results.every((by) => by === 'raf')).toBe(true);
    expect(waiters).toHaveLength(0);
  });

  it('resolves on the event when it comes first', async () => {
    const waiters: Array<() => void> = [];
    const pending = waitForEventOrLayoutPass(waiters);
    waiters.splice(0, waiters.length).forEach((resolve) => resolve());
    await jest.advanceTimersByTimeAsync(64);
    expect(await pending).toBe('evt');
    expect(waiters).toHaveLength(0);
  });
});
