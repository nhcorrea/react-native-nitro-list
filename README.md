# react-native-nitro-list

[![npm version](https://img.shields.io/npm/v/@nhcorrea/react-native-nitro-list)](https://www.npmjs.com/package/@nhcorrea/react-native-nitro-list)
[![license](https://img.shields.io/npm/l/@nhcorrea/react-native-nitro-list)](./LICENSE)

High-performance drop-in FlatList replacement for React Native, powered by [Nitro Modules](https://nitro.margelo.com).

The layout engine is shared C++ (compiled on both platforms), driven by native views written in Swift and Kotlin, with a thin React layer on top. Scroll offsets, engaged-range resolution, and layout math run outside the React render loop — React only renders the cells the engine asks for.

## Features

- **FlatList-compatible API** — `data`, `renderItem`, `keyExtractor`, `onEndReached`, `onViewableItemsChanged`, sticky headers, header/footer/empty/separator components.
- **Shared C++ layout engine** — O(log n) engaged-range resolution, measurement caching, single-pass correction after real cell measurements land.
- **Accurate `scrollToIndex`** — jumps straight to the target with measure-and-correct convergence, including dynamic-height content.
- **Chat-friendly** — `maintainVisibleContentPosition` (prepend without visual jumps), `alignItemsAtEnd`, `maintainScrollAtEnd`, `onStartReached`.
- **`initialScrollIndex` without flash** — the first rendered window *is* the destination.
- **Experimental UI-thread scroll driver** — with `experimentalUiThreadScroll`, a Reanimated worklet drives the engine and positions sticky headers on the UI thread; the JS thread is only woken when the rendered range actually changes.
- **Built-in perf instrumentation** — `NitroListPerfMonitor` measures blank-area, mount latency distributions, and scroll performance.

## Requirements

- React Native with the **new architecture** enabled (tested with RN 0.86)
- [`react-native-nitro-modules`](https://www.npmjs.com/package/react-native-nitro-modules) (tested with 0.35.x)
- [`react-native-reanimated`](https://www.npmjs.com/package/react-native-reanimated) 4+ with its peer [`react-native-worklets`](https://www.npmjs.com/package/react-native-worklets) 0.10+ (make sure the worklets babel plugin is in your `babel.config.js`, as required by Reanimated itself)

## Installation

```sh
npm install @nhcorrea/react-native-nitro-list react-native-nitro-modules react-native-reanimated react-native-worklets
cd ios && pod install
```

## Quick start

```tsx
import { NitroList, type NitroListRenderItem } from '@nhcorrea/react-native-nitro-list';

type Item = { id: string; title: string };

function MyList({ items }: { items: Item[] }) {
  const renderItem: NitroListRenderItem<Item> = ({ item }) => (
    <Row title={item.title} />
  );

  return (
    <NitroList
      data={items}
      renderItem={renderItem}
      estimatedItemSize={64}
      keyExtractor={item => item.id}
    />
  );
}
```

`estimatedItemSize` is required — it is used for layout until each cell reports its measured size, after which real measurements take over.

## API

### Main props

| Prop | Description |
| --- | --- |
| `data` | `ReadonlyArray<T>` to render. |
| `renderItem` | `({ item, index }) => ReactElement`. |
| `estimatedItemSize` | Estimated cell height in dp (required). |
| `keyExtractor` | Stable identity per item — required for prepend/insert tracking and `maintainVisibleContentPosition`. |
| `getItemType` | Segments React keys by cell type so a header cell is never reused as a row cell. |
| `getFixedItemSize` | `(item, index, type) => number \| undefined` — return the exact height in dp when known. Fixed-size cells skip measurement entirely (no `onLayout`), so offsets are exact from the first batch. The value must match the real layout (dev builds warn on divergence). |
| `itemsAreEqual` | `(prev, next, index) => boolean` — with a stable function, a new data array whose items are recreated-but-equal re-renders zero rows. Compare visual content only; the key is already equal by construction. |
| `drawDistance` | How far beyond the viewport (dp) to render. |
| `horizontal` | Row layout: offsets/measurements/sticky/viewability all run on the x axis (cells report their width). |
| `numColumns` / `overrideItemLayout` / `columnWrapperStyle` | Grid layout: rows advance by their tallest cell; `overrideItemLayout(layout, item, index)` sets per-item spans; `columnWrapperStyle` supports `{ rowGap, columnGap }`. Cross-axis placement is percentage-based, so rotation reflows for free. Changing `numColumns` re-measures everything (cell width changed). |
| `onEndReached` / `onStartReached` | Latched edge callbacks with hysteresis, viewport-relative thresholds. |
| `maintainVisibleContentPosition` | `boolean` or `{ data?, size?, shouldRestorePosition? }`. **Since v2, `size` defaults to ON**: position stays stable while content above the viewport re-measures, for every list. `data` (prepend anchoring) stays opt-in. `true` enables both, `false` disables both. `shouldRestorePosition` vetoes anchor candidates (e.g. optimistic messages about to be replaced). |
| `alignItemsAtEnd` / `maintainScrollAtEnd` | Chat-style bottom alignment and auto-stick to new content (footer growth re-sticks; user drags cancel; growth during a stick coalesces). |
| `anchoredEndSpace` | AI-chat pattern: `{ anchorIndex, anchorOffset?, anchorMaxSize?, onSizeChanged?, onReady? }` — pads the tail so the anchor message pins to the viewport top while the response grows into the pad (content height stays constant, so nothing jumps). Wins over `maintainScrollAtEnd` while active. |
| `alwaysRender` | `{ top?, bottom?, indices?, keys? }` — keep specific cells mounted outside the visible window (chat anchors, accessibility). Pinned cells never report viewability. |
| `initialScrollIndex` / `initialScrollOffset` / `initialScrollAtEnd` | Mount already positioned. The list stays at `opacity: 0` until the target converges (2 stable passes with the same visible set), with a hard reveal timeout so it never stays hidden. |
| `stickyHeaderIndices` / `stickyHeaderConfig` | Sticky headers. |
| `viewabilityConfig` / `onViewableItemsChanged` | FlashList-compatible viewability tracking. |
| `snapToIndices` | Snap points computed live from the layout engine's offsets (they track measurements). |
| `adaptiveRenderMode` | Opt-in: `renderItem` receives `renderMode: 'normal' \| 'fast'` (Schmitt trigger on scroll velocity) so heavy cells can render placeholders mid-fling. |
| `onLoad` | `({ elapsedTimeInMs }) => void` — fires once when the first range renders, with time since mount. |
| `onFirstVisibleItemChanged` | `({ index, item, key }) => void` — cheap first-visible signal, deduped by index. |
| `onItemSizeChanged` | `({ index, size }) => void` — every measurement flushed to the layout engine (dev/tuning). |
| `ListHeaderComponent` / `ListFooterComponent` / `ListEmptyComponent` / `ItemSeparatorComponent` | Structural components, measured into the scroll math automatically. |
| `renderScrollComponent` | Provide your own outer ScrollView (e.g. `Animated.ScrollView`). Forward every prop you receive — in particular `maintainVisibleContentPosition`, which MVCP relies on since v1.6 — and keep `removeClippedSubviews` off. |
| `experimentalUiThreadScroll` | Drive the engine's scroll offset (and sticky headers) from the UI thread — see below. |
| `onScrollWorklet` | Reanimated worklet called per scroll tick on the UI runtime (UI-thread mode only). |
| `scrollOffsetSharedValue` | A `SharedValue<number>` kept in sync with the scroll offset — drive parallax/collapsing headers from it. |

See the full documented prop list in [`src/NitroList.tsx`](./src/NitroList.tsx) (`NitroListProps`).

### Imperative handle

```tsx
const ref = useRef<NitroListHandle>(null);

await ref.current?.scrollToIndex({ index: 500, animated: true });
await ref.current?.scrollToOffset({ offset: 0 });
await ref.current?.scrollToEnd(true);
```

All scroll commands return a `Promise` that settles when the scroll lands — and a superseded command (a newer command or a user drag takes over) always resolves immediately, so callers never hang. Commands issued right after a data change wait for the layout to stabilize (up to 2 stable frames, 800ms cap) before computing their target.

`getScrollableNode()` / `getNativeScrollRef()` expose the outer scroll node for third-party interop (`useScrollOffset`, `scrollTo`, `measure`, `dispatchCommand`).

`getAverageItemSizes()` returns `Record<type, { average, count }>` straight from the native layout engine's per-type running means — use it to tune `estimatedItemSize` (untyped lists report under the `''` key).

`scrollIndexIntoView({ index })` / `scrollItemIntoView({ item })` scroll only when the target is off-screen, aligning to the nearest edge by direction.

`reportContentInset({ bottom })` tells the list the scrollable range was extended by a synthetic content inset (keyboard/composer) so `scrollToEnd` and max-offset math land correctly — the `/keyboard` entry point wires this automatically.

### Sections (`/section-list` entry point)

```tsx
import { NitroSectionList } from '@nhcorrea/react-native-nitro-list/section-list';

<NitroSectionList
  sections={sections}
  estimatedItemSize={64}
  keyExtractor={(item) => item.id}
  renderItem={({ item, index, section }) => <Row item={item} />}
  renderSectionHeader={({ section }) => <Header title={section.title} />}
/>
```

Sections are flattened into a typed row union (`header | item | separator | footer`) over one NitroList — each row kind gets its own native size statistics for free. Sticky section headers, `scrollToLocation({ sectionIndex, itemIndex })` (0 = the header, like RN) and SectionList-style viewability tokens (with `section` / `sectionIndex`) are included.

### Keyboard-aware chat (`/keyboard` entry point)

```tsx
import { KeyboardAwareNitroList, useKeyboardScrollToEnd } from '@nhcorrea/react-native-nitro-list/keyboard';

<KeyboardAwareNitroList
  data={messages}
  renderItem={renderMessage}
  estimatedItemSize={72}
  keyExtractor={(m) => m.id}
  anchoredEndSpace={{ anchorIndex: lastUserMessageIndex }}
  keyboardLiftBehavior="whenAtEnd"
/>
```

Requires the optional peer `react-native-keyboard-controller` (>= 1.21.7). The wrapper renders through its `KeyboardChatScrollView`, feeds `anchoredEndSpace`'s pad into the keyboard `blankSpace` floor (so opening the keyboard absorbs into the pad instead of shoving content), and routes content-inset changes into `reportContentInset`. `useKeyboardScrollToEnd(ref)` gives you dismiss + scroll-to-end in parallel.

### UI-thread scroll mode (experimental)

```tsx
<NitroList
  data={items}
  renderItem={renderItem}
  estimatedItemSize={64}
  experimentalUiThreadScroll
  onScrollWorklet={(event) => {
    'worklet';
    headerOffset.value = event.contentOffset.y; // runs on the UI thread
  }}
/>
```

With `experimentalUiThreadScroll` on, a Reanimated worklet is the only scroll
driver: it feeds the native engine and positions sticky headers per frame on
the UI thread, and the JS thread wakes **only when the rendered range
changes** (plus throttled ticks when `onViewableItemsChanged` is set). During
a steady scroll inside the rendered window, your app's JS budget is untouched.

Notes:

- The default outer ScrollView becomes an `Animated.ScrollView` automatically.
  A custom `renderScrollComponent` must be backed by one.
- `onScrollWorklet` must carry the `'worklet'` directive — automatic
  workletization does not cross package boundaries.
- A plain JS `onScroll` still works but costs one JS wakeup per tick and
  receives a minimal synthesized event (`{nativeEvent: {contentOffset}}`).
- If animated components stutter *during* scroll, look at Reanimated's
  app-side static feature flags (`DISABLE_COMMIT_PAUSING_MECHANISM`, plus
  React Native's `preventShadowTreeCommitExhaustion` on RN 0.81+) — only the
  app can set those.

### Performance monitoring

```ts
import { NitroListPerfMonitor } from '@nhcorrea/react-native-nitro-list';

NitroListPerfMonitor.enable();
// ... interact with the list ...
console.log(NitroListPerfMonitor.getSnapshot());
```

The snapshot covers blank-area pixels during scroll, mount/unmount rates and
burst sizes, scroll→range latency tails (p50/p95/p99), and `scrollToIndex`
convergence stats — metric definitions are documented in
[`src/PerfMonitor.ts`](./src/PerfMonitor.ts). A ready-made benchmark harness
ships in [`src/dev/NitroListBenchmarkScreen.tsx`](./src/dev/NitroListBenchmarkScreen.tsx)
— mount it on a dev route to run scripted scroll benchmarks.

## Example app

```sh
npm install
cd example
npm run pod   # iOS
npm run ios   # or: npm run android
```

## Development

- `npm run codegen` — regenerate Nitro bindings (`nitrogen/generated`) after touching `src/NitroListView.nitro.ts`, then build.
- `npm test` — Jest suite for the TS layer (measurement cache, prewarm admission, perf monitor).
- `npm run test:cpp` — compiles and runs the C++ `LayoutCore` host tests with ASan/UBSan (no device needed).
- `npm run typecheck` / `npm run build` — TS validation and library output (`lib/`).

## License

MIT © Nathã Corrêa
