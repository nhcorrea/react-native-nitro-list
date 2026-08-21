export function scheduleOnRN<A extends unknown[]>(fn: (...args: A) => void, ...args: A): void {
  fn(...args);
}

export function scheduleOnUI<A extends unknown[]>(fn: (...args: A) => void, ...args: A): void {
  fn(...args);
}
