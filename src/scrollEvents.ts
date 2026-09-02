export type NitroListScrollEventKind = 'user' | 'programmatic' | 'large-jump';

export function classifyScrollEvent(
  offset: number,
  previousOffset: number,
  viewportHeight: number,
  programmaticAnimated: boolean,
): NitroListScrollEventKind {
  if (programmaticAnimated) return 'programmatic';
  if (viewportHeight > 0 && Math.abs(offset - previousOffset) > viewportHeight) {
    return 'large-jump';
  }
  return 'user';
}

export type NitroListScrollCommandEcho = {
  from: number;
  target: number;
  time: number;
  staleOffset: number | null;
};

export function noteScrollCommand(
  previous: NitroListScrollCommandEcho | null,
  from: number,
  target: number,
  nowMs: number,
  maxAgeMs: number,
): NitroListScrollCommandEcho {
  const live = previous != null && nowMs - previous.time <= maxAgeMs;
  return {
    from: live ? previous.from : from,
    target,
    time: nowMs,
    staleOffset: live ? previous.staleOffset : null,
  };
}

export type NitroListScrollEchoKind =
  | 'none'
  | 'stale'
  | 'resolved';

export function classifyScrollEcho(
  offset: number,
  command: NitroListScrollCommandEcho | null,
  nowMs: number,
  epsilon: number,
  maxAgeMs: number,
): NitroListScrollEchoKind {
  if (command == null) return 'none';
  if (nowMs - command.time > maxAgeMs) return 'resolved';
  if (Math.abs(offset - command.target) <= epsilon) return 'resolved';
  const low = Math.min(command.from, command.target) - epsilon;
  const high = Math.max(command.from, command.target) + epsilon;
  if (offset < low || offset > high) return 'resolved';
  if (command.staleOffset != null && Math.abs(offset - command.staleOffset) <= epsilon) {
    return 'resolved';
  }
  return 'stale';
}
