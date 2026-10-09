export type StickyComputeResult = {index: number; translateY: number; height: number};
export type StickyLayoutReader = {
  getItemOffset: (index: number) => number;
  getItemSize: (index: number) => number;
};

export function createStickyResult(): StickyComputeResult {
  'worklet';
  return {index: -1, translateY: 0, height: 0};
}

export function computeSticky(
  scrollOffset: number,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  reader: StickyLayoutReader,
  overlaySize: number,
  out: StickyComputeResult,
): StickyComputeResult {
  'worklet';
  const bar = scrollOffset + stickyOffset;
  let activeK = -1;
  let lo = 0;
  let hi = stickyIndices.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (reader.getItemOffset(stickyIndices[mid]) <= bar) {
      activeK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (activeK === -1) {
    out.index = -1;
    out.translateY = stickyOffset;
    out.height = 0;
    return out;
  }
  const idx = stickyIndices[activeK];
  const h = overlaySize > 0 ? overlaySize : reader.getItemSize(idx);
  let translateY = stickyOffset;
  const nextK = activeK + 1;
  if (nextK < stickyIndices.length) {
    const nextNaturalY = reader.getItemOffset(stickyIndices[nextK]) - scrollOffset;
    if (nextNaturalY < stickyOffset + h) {
      translateY = nextNaturalY - h;
    }
  }
  out.index = idx;
  out.translateY = translateY;
  out.height = h;
  return out;
}

export type StickyPush = {start: number; end: number; from: number; to: number};

export function stickyPushFor(
  result: StickyComputeResult,
  stickyIndices: ReadonlyArray<number>,
  stickyOffset: number,
  reader: StickyLayoutReader,
  scrollOrigin: number,
): StickyPush {
  let lo = 0;
  let hi = stickyIndices.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stickyIndices[mid] <= result.index) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const next = at >= 0 && at + 1 < stickyIndices.length ? stickyIndices[at + 1] : -1;
  if (next < 0 || !(result.height > 0)) return {start: 0, end: 1, from: stickyOffset, to: stickyOffset};
  const start = reader.getItemOffset(next) - stickyOffset - result.height + scrollOrigin;
  return {start, end: start + result.height, from: stickyOffset, to: stickyOffset - result.height};
}

export function sameStickyPush(a: StickyPush | null, b: StickyPush): boolean {
  return a != null && a.start === b.start && a.end === b.end && a.from === b.from && a.to === b.to;
}
