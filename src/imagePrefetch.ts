import {PixelRatio} from 'react-native';

import {cancelNitroListImagePrefetch, prefetchNitroListImages} from './nativeHost';

export type GetImageUrisFn<T> = (
  item: T,
  index: number,
) => string | ReadonlyArray<string> | null | undefined;

export interface ImagePrefetchConfig {
  lookaheadItems?: number;
  width?: number;
  height?: number;
}

const DEFAULT_LOOKAHEAD_ITEMS = 8;
const MAX_RECENT_URIS = 128;

export interface ImagePrefetcher<T> {
  onRange: (
    items: ReadonlyArray<T>,
    start: number,
    end: number,
    velocityDpS: number,
    getImageUris: GetImageUrisFn<T> | undefined,
    config: ImagePrefetchConfig | undefined,
  ) => void;
  cancel: () => void;
  reset: () => void;
}

export function createImagePrefetcher<T>(): ImagePrefetcher<T> {
  let lastDirection: -1 | 0 | 1 = 0;
  let lastRangeStart = -1;
  let lastRangeEnd = -1;
  const recentSet = new Set<string>();
  const recentQueue: string[] = [];

  const remember = (uri: string): boolean => {
    if (recentSet.has(uri)) return false;
    if (recentQueue.length >= MAX_RECENT_URIS) {
      const oldest = recentQueue.shift();
      if (oldest != null) recentSet.delete(oldest);
    }
    recentSet.add(uri);
    recentQueue.push(uri);
    return true;
  };

  const onRange = (
    items: ReadonlyArray<T>,
    start: number,
    end: number,
    velocityDpS: number,
    getImageUris: GetImageUrisFn<T> | undefined,
    config: ImagePrefetchConfig | undefined,
  ): void => {
    if (getImageUris == null || items.length === 0 || end < start) return;

    let direction: -1 | 0 | 1 = lastDirection;
    if (velocityDpS > 100) direction = 1;
    else if (velocityDpS < -100) direction = -1;
    else if (lastRangeStart >= 0) {
      if (start > lastRangeStart || end > lastRangeEnd) direction = 1;
      else if (start < lastRangeStart || end < lastRangeEnd) direction = -1;
    }

    if (direction === 0) direction = 1;

    // Cancel stale in-flight fetches immediately when scroll direction reverses!
    if (lastDirection !== 0 && direction !== lastDirection) {
      cancelNitroListImagePrefetch();
    }
    lastDirection = direction;
    lastRangeStart = start;
    lastRangeEnd = end;

    const lookahead = Math.max(1, Math.trunc(config?.lookaheadItems ?? DEFAULT_LOOKAHEAD_ITEMS));
    const lo = direction > 0 ? Math.min(items.length, end + 1) : Math.max(0, start - lookahead);
    const hi = direction > 0 ? Math.min(items.length, end + 1 + lookahead) : Math.max(0, start);
    if (hi <= lo) return;

    const batch: string[] = [];
    for (let i = lo; i < hi; i++) {
      const result = getImageUris(items[i], i);
      if (result == null) continue;
      if (typeof result === 'string') {
        if (result.length > 0 && remember(result)) batch.push(result);
      } else {
        for (let k = 0; k < result.length; k++) {
          const uri = result[k];
          if (uri != null && uri.length > 0 && remember(uri)) batch.push(uri);
        }
      }
    }

    if (batch.length === 0) return;
    const scale = PixelRatio.get();
    const widthPx = config?.width != null && config.width > 0 ? Math.round(config.width * scale) : 0;
    const heightPx =
      config?.height != null && config.height > 0 ? Math.round(config.height * scale) : 0;
    prefetchNitroListImages(batch, widthPx, heightPx);
  };

  const cancel = (): void => {
    cancelNitroListImagePrefetch();
  };

  const reset = (): void => {
    cancelNitroListImagePrefetch();
    lastDirection = 0;
    lastRangeStart = -1;
    lastRangeEnd = -1;
    recentSet.clear();
    recentQueue.length = 0;
  };

  return {onRange, cancel, reset};
}
