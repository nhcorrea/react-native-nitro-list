import type {HybridObject} from 'react-native-nitro-modules';

/** Internal Android commands; cancellation and replacement share the UI queue. */
export interface NitroListScrollView extends HybridObject<{android: 'kotlin'}> {
  scrollTo(viewTag: number, x: number, y: number, animated: boolean): void;
  setEagerMount(enabled: boolean): void;
}
