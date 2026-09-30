import {useRef} from 'react';

type Target<F> = {current: F};
type Forwarded = (a?: unknown, b?: unknown, c?: unknown, d?: unknown) => unknown;

export type StableCallbackBindings = unknown[];

function createStableCallback<F>(target: Target<F>): F {
  const stable: Forwarded = (a, b, c, d) => (target.current as Forwarded)(a, b, c, d);
  return stable as F;
}

export function useStableCallback<F extends (...args: never[]) => unknown>(
  bindings: StableCallbackBindings,
  callback: F,
): F {
  const slot = useRef<{target: Target<F>; stable: F} | null>(null);
  if (slot.current == null) {
    const target = {current: callback};
    slot.current = {target, stable: createStableCallback(target)};
  }
  bindings.push(slot.current.target, callback);
  return slot.current.stable;
}

export function publishStableCallbacks(bindings: StableCallbackBindings): void {
  for (let i = 0; i < bindings.length; i += 2) {
    (bindings[i] as Target<unknown>).current = bindings[i + 1];
  }
}
