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
