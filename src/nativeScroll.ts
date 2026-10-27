import {Platform, type ScrollView} from 'react-native';
import {NitroModules} from './nitroModules';
import type {NitroListScrollView} from './NitroListScrollView.nitro';

let androidScrollView: NitroListScrollView | undefined;

export function scrollToNativeOffset(
  view: ScrollView | null,
  offset: number,
  horizontal: boolean,
  animated: boolean,
): void {
  if (view == null) return;
  const x = horizontal ? offset : 0;
  const y = horizontal ? 0 : offset;
  if (Platform.OS === 'android') {
    const tag = view.getScrollableNode?.();
    if (typeof tag === 'number' && Number.isInteger(tag) && tag > 0) {
      androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
      androidScrollView.scrollTo(tag, x, y, animated);
      return;
    }
  }
  view.scrollTo({x, y, animated});
}

export function setNativeEagerMount(enabled: boolean): void {
  if (Platform.OS !== 'android') return;
  androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
  androidScrollView.setEagerMount(enabled);
}

export function setNativeClipChildren(viewTag: number, enabled: boolean): void {
  if (Platform.OS !== 'android' || !Number.isInteger(viewTag) || viewTag <= 0) return;
  androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
  androidScrollView.setClipChildren(viewTag, enabled);
}

export function observeNativeMounts(
  markerTag: number,
  onMounted: (sequence: number, mountMs: number) => void,
): number {
  if (Platform.OS !== 'android' || !Number.isInteger(markerTag) || markerTag <= 0) return -1;
  androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
  return androidScrollView.observeMounts(markerTag, onMounted);
}

export function unobserveNativeMounts(id: number): void {
  if (Platform.OS !== 'android' || id <= 0) return;
  androidScrollView?.unobserveMounts(id);
}

export function nativeMountedAt(id: number, sequence: number): number {
  if (Platform.OS !== 'android' || id <= 0 || androidScrollView == null) return -1;
  return androidScrollView.mountedAtMs(id, sequence);
}

export function setNativeTransitionDiagnostics(enabled: boolean): void {
  if (Platform.OS !== 'android') return;
  androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
  androidScrollView.setTransitionDiagnostics(enabled);
}

export function markNativeTransition(origin: number, sequence: number, revision: number, count: number, flags: number): void {
  if (Platform.OS !== 'android') return;
  androidScrollView ??= NitroModules.createHybridObject<NitroListScrollView>('NitroListScrollView');
  androidScrollView.markTransition(origin, sequence, revision, count, flags);
}
