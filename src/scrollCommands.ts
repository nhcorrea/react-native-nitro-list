export function flushWaiters(waiters: Array<() => void>): void {
  if (waiters.length === 0) return;
  const pending = waiters.splice(0, waiters.length);
  for (const resolve of pending) resolve();
}

export function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function waitForLayoutPass(): Promise<void> {
  await waitForNextFrame();
  await waitForNextFrame();
}

export function interpolateOffset(start: number, end: number, step: number, totalSteps: number): number {
  if (totalSteps <= 1) return end;
  const progress = step / (totalSteps - 1);
  return start + (end - start) * progress;
}

