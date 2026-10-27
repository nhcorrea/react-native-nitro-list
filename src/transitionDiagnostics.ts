import {NitroListDevFlags} from './devFlags';
import {markNativeTransition} from './nativeScroll';

export const TRANSITION_ORIGIN = {
  unknown: 0,
  range: 1,
  prewarm: 2,
  reserve: 3,
  measure: 4,
  data: 5,
  correction: 6,
  driver: 7,
  mount: 8,
  other: 9,
} as const;

export const TRANSITION_FLAG = {
  essential: 1,
  optional: 2,
  coalesced: 4,
  superseded: 8,
} as const;

export function transitionFlags(essential: boolean | undefined, coalesced = false, superseded = false): number {
  return (essential === true ? TRANSITION_FLAG.essential : essential === false ? TRANSITION_FLAG.optional : 0) |
    (coalesced ? TRANSITION_FLAG.coalesced : 0) | (superseded ? TRANSITION_FLAG.superseded : 0);
}

export function markTransition(origin: number, sequence: number, revision: number, count: number, flags: number): void {
  if (!NitroListDevFlags.transitionDiagnostics) return;
  markNativeTransition(origin, sequence, revision, count, flags);
}
