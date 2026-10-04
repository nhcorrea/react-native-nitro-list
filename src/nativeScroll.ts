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
