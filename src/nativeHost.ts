import {Platform} from 'react-native';

import {NitroModules} from './nitroModules';
import type {NitroListNativeHost} from './NitroListNativeHost.nitro';

export type NativeSlotRebindsCallback = (
  slotCount: number,
  rangeStart: number,
  rangeEnd: number,
  layoutVersion: number,
  totalSize: number,
  stickyIndex: number,
  velocityDpS: number,
  deltas: ArrayBuffer,
) => void;

export type NativeContentSizeCallback = (totalSize: number, layoutVersion: number) => void;

let nativeHostInstance: NitroListNativeHost | null | undefined;

function getNativeHost(): NitroListNativeHost | null {
  if (nativeHostInstance !== undefined) return nativeHostInstance;
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    nativeHostInstance = null;
    return null;
  }
  try {
    const candidate = NitroModules.createHybridObject<NitroListNativeHost>('NitroListNativeHost');
    nativeHostInstance =
      candidate != null && typeof candidate.attachHost === 'function' ? candidate : null;
  } catch {
    nativeHostInstance = null;
  }
  return nativeHostInstance;
}

export function resetNativeHostCacheForTests(): void {
  nativeHostInstance = undefined;
}

export function isNativeHostSupported(): boolean {
  return getNativeHost() != null;
}

export function attachNativeHost(
  engineId: number,
  scrollViewTag: number,
  stickyViewTag: number,
  horizontal: boolean,
  userHasOnScroll: boolean,
  onSlotRebinds: NativeSlotRebindsCallback,
  onContentSize: NativeContentSizeCallback,
): number {
  const host = getNativeHost();
  if (host == null || !Number.isFinite(engineId) || engineId <= 0 || scrollViewTag <= 0) return -1;
  return host.attachHost(
    engineId,
    scrollViewTag,
    stickyViewTag,
    horizontal,
    userHasOnScroll,
    onSlotRebinds,
    onContentSize,
  );
}

export function detachNativeHost(hostId: number): void {
  if (hostId <= 0) return;
  getNativeHost()?.detachHost(hostId);
}

export function registerNativeSlotView(
  hostId: number,
  slotId: number,
  viewTag: number,
  measures: boolean,
): void {
  if (hostId <= 0 || slotId < 0 || viewTag <= 0) return;
  getNativeHost()?.registerSlotView(hostId, slotId, viewTag, measures);
}

export function unregisterNativeSlotView(hostId: number, slotId: number): void {
  if (hostId <= 0 || slotId < 0) return;
  getNativeHost()?.unregisterSlotView(hostId, slotId);
}

export function setNativeSlotMeasures(hostId: number, slotId: number, measures: boolean): void {
  if (hostId <= 0 || slotId < 0) return;
  getNativeHost()?.setSlotMeasures(hostId, slotId, measures);
}

export function setNativeStickyViewTag(hostId: number, stickyViewTag: number): void {
  if (hostId <= 0) return;
  getNativeHost()?.setStickyViewTag(hostId, stickyViewTag);
}

export function setNativeHostUserHasOnScroll(hostId: number, hasOnScroll: boolean): void {
  if (hostId <= 0) return;
  getNativeHost()?.setUserHasOnScroll(hostId, hasOnScroll);
}

export function setNativeHostMvcpEnabled(hostId: number, enabled: boolean): void {
  if (hostId <= 0) return;
  getNativeHost()?.setMvcpEnabled(hostId, enabled);
}

export function applyNativeHostMvcpShift(hostId: number, deltaDp: number): void {
  if (hostId <= 0 || !Number.isFinite(deltaDp) || deltaDp === 0) return;
  getNativeHost()?.applyMvcpShift(hostId, deltaDp);
}

export function notifyNativeHostDataCommit(
  hostId: number,
  paddingStartDp: number,
  mainAxisGapDp: number,
): void {
  if (hostId <= 0) return;
  getNativeHost()?.notifyDataCommit(hostId, paddingStartDp, mainAxisGapDp);
}

export function syncNativeHostNow(hostId: number): void {
  if (hostId <= 0) return;
  getNativeHost()?.syncNow(hostId);
}

export function prefetchNitroListImages(
  uris: ReadonlyArray<string>,
  widthPx = 0,
  heightPx = 0,
): void {
  if (uris.length === 0) return;
  getNativeHost()?.prefetchImages(uris as string[], widthPx, heightPx);
}

export function cancelNitroListImagePrefetch(): void {
  getNativeHost()?.cancelImagePrefetch();
}
