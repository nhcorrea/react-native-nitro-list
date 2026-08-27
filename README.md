# react-native-nitro-list

[![npm version](https://img.shields.io/npm/v/@nhcorrea/react-native-nitro-list)](https://www.npmjs.com/package/@nhcorrea/react-native-nitro-list)
[![license](https://img.shields.io/npm/l/@nhcorrea/react-native-nitro-list)](./LICENSE)

High-performance drop-in `FlatList` replacement for React Native, powered by [Nitro Modules](https://nitro.margelo.com).

The layout engine is shared C++ compiled into both platforms, driven by native views written in Swift and Kotlin, with a thin React layer on top. Scroll offsets, engaged-range resolution and layout math run outside the React render loop — React is only asked to render the cells that are actually needed.

- [Why it's fast](#why-its-fast)
- [Requirements](#requirements) · [Installation](#installation) · [Quick start](#quick-start)
- [Coming from FlatList](#coming-from-flatlist)
- [Props](#props) · [Imperative handle](#imperative-handle) · [Exported types](#exported-types)
- [Sections](#sections-section-list) · [Keyboard-aware chat](#keyboard-aware-chat-keyboard)
- [UI-thread scroll mode](#ui-thread-scroll-mode-experimental)
- [Performance monitoring](#performance-monitoring-dev) · [Development warnings](#development-warnings)
- [Recipes](#recipes) · [Troubleshooting](#troubleshooting)

## Why it's fast

**The layout lives in C++, not in React.** Item sizes, prefix offsets, total size and the engaged range live in a single native structure shared by iOS and Android. Resolving "which items are on screen" is a binary search over the offset prefix (O(log n)), and repeated queries inside the same window are answered from a cached range — so a 100k-item list resolves its range in the same time as a 1k-item list. React never walks the data array to find out what to draw.

**Measurements are batched into one native call.** Cells report their real size through a batched bridge: a whole batch of freshly mounted cells is flushed as a single JSI call per frame instead of one call per cell. Offsets are corrected in place, and only the items after the first changed index are recomputed.

**Cells that don't need to change don't re-render.** Cell content is memoized per key, so scrolling reuses mounted cells instead of re-rendering them. With `itemsAreEqual`, a brand-new data array whose items are recreated-but-equal re-renders zero rows.

**Measurement can be skipped entirely.** `getFixedItemSize` (explicit) and `autoFixedItemSizes` (learned) let known-height cells skip the `onLayout` round trip completely — their offsets are exact from the first frame, so there is no measure → correct → re-render cycle at all.

**Scrolling doesn't have to wake JS.** With `experimentalUiThreadScroll`, a Reanimated worklet feeds the engine and positions sticky headers on the UI thread, and the JS thread is woken **only when the rendered range actually changes** — not once per scroll frame.

**The window is kept ahead of the finger.** The engaged range is extended in the direction of travel, a fling is projected ahead so its landing zone is already mounted, and range edges have hysteresis so a jittery boundary doesn't unmount and remount the same cell every frame.

**Scroll commands converge instead of guessing.** `scrollToIndex` renders the destination window first, then measures and corrects until the target offset is exact — so it lands precisely even on lists whose heights are only known after layout, and every scroll command returns a `Promise` that settles when the scroll actually lands.

## Requirements

- React Native with the **new architecture** enabled (developed against RN 0.86)
- [`react-native-nitro-modules`](https://www.npmjs.com/package/react-native-nitro-modules) (0.35.x)
- [`react-native-reanimated`](https://www.npmjs.com/package/react-native-reanimated) 4+ with its peer [`react-native-worklets`](https://www.npmjs.com/package/react-native-worklets) 0.10+ — make sure the worklets Babel plugin is in your `babel.config.js`, as Reanimated itself requires
- Optional: [`react-native-keyboard-controller`](https://www.npmjs.com/package/react-native-keyboard-controller) 1.21.7+, only for the [`/keyboard`](#keyboard-aware-chat-keyboard) entry point

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
  const renderItem: NitroListRenderItem<Item> = ({ item }) => <Row title={item.title} />;

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

Two things matter from the start:

- **`estimatedItemSize` is required.** It drives layout until each cell reports its measured size, after which real measurements take over. Get it roughly right and the first frames are already stable; get it badly wrong and dev builds will tell you (see [Development warnings](#development-warnings)).
- **The list needs a bounded height.** `flex: 1` inside a flex parent, or an explicit height. Nothing renders while the viewport measures 0.

## Coming from FlatList

`data`, `renderItem`, `keyExtractor`, `onEndReached`, `onViewableItemsChanged`, `viewabilityConfig`, `numColumns`, `horizontal`, `stickyHeaderIndices`, `ListHeaderComponent` / `ListFooterComponent` / `ListEmptyComponent` / `ItemSeparatorComponent`, `initialScrollIndex` and the scroll-event callbacks all behave as you expect.

The differences worth knowing:

| FlatList | NitroList |
| --- | --- |
| `getItemLayout` | Not needed — the engine keeps offsets. Use `getFixedItemSize` when heights are known. |
| `windowSize` / `maxToRenderPerBatch` / `initialNumToRender` | Replaced by `drawDistance` (dp beyond the viewport, default `250`). |
| `removeClippedSubviews` | Not applicable — cells outside the window aren't mounted. Keep it **off** on any custom ScrollView. |
| `scrollToIndex` may throw / needs `getItemLayout` | Always available, returns a `Promise`, converges on dynamic heights. |
| No estimate needed | `estimatedItemSize` is required. |
| — | `keyExtractor` is strongly recommended: without it, every data change drops measured sizes back to estimates. |

## Props

### Data and rendering

| Prop | Type | Description |
| --- | --- | --- |
| `data` | `ReadonlyArray<T> \| null \| undefined` | The items to render. |
| `renderItem` | `({ item, index, target, renderMode }) => ReactElement \| null` | Renders one cell. `target` is `'Cell'` or `'StickyHeader'`; `renderMode` is only present with `adaptiveRenderMode`. |
| `estimatedItemSize` | `number` | **Required.** Estimated cell size in dp (height, or width when `horizontal`). |
| `keyExtractor` | `(item, index) => string` | Stable identity per item. Required in practice for prepend/insert tracking and `maintainVisibleContentPosition`; without it a data change invalidates every measurement. |
| `getItemType` | `(item, index) => string \| number` | Segments React keys by cell type, so a header cell is never recycled into a row cell. Also gives each type its own size statistics. |
| `getFixedItemSize` | `(item, index, type) => number \| undefined` | Return the exact size in dp when it's known. Fixed-size cells skip measurement entirely (no `onLayout`), so offsets are exact from the first batch. The value must match the real layout — dev builds warn on divergence. |
| `autoFixedItemSizes` | `boolean` | Opt-in; needs `getItemType`. Once a type has measured at least 32 cells with near-zero variance (cache keyed by width bucket and font scale, shared across mounts), its cells are treated as fixed-size automatically — same effect as `getFixedItemSize`, with no measurement round trip. A cell that later lays out differently unfreezes the type and reports its real size. |
| `itemsAreEqual` | `(prev, next, index) => boolean` | With a stable function reference, a new data array whose items are recreated-but-equal re-renders zero rows. Compare visual content only — the key is already equal by construction. |
| `dataVersion` | `unknown` | Escape hatch for in-place mutation: change this value to force the list to treat `data` as changed even when the array identity did not. |

### Layout

| Prop | Type | Description |
| --- | --- | --- |
| `drawDistance` | `number` | How far beyond the viewport to render, in dp. Default `250`. Higher means fewer chances of blank space during fast scrolls at the cost of more mounted cells. |
| `horizontal` | `boolean` | Row layout: offsets, measurements, sticky headers and viewability all run on the x axis (cells report their width). |
| `numColumns` | `number` | Grid layout. Rows advance by their tallest cell. Changing the value re-measures everything, since cell width changed. Ignored when `horizontal`. |
| `overrideItemLayout` | `(layout: { span }, item, index) => void` | Set a per-item column span by mutating `layout.span`. |
| `columnWrapperStyle` | `{ rowGap?, columnGap? }` | Grid gaps. Cross-axis placement is percentage-based, so rotation reflows for free. |
| `snapToIndices` | `readonly number[]` | Snap points computed live from the engine's offsets, so they track real measurements. |
| `adaptiveRenderMode` | `boolean` | Opt-in. `renderItem` receives `renderMode: 'normal' \| 'fast'` driven by a Schmitt trigger on scroll velocity, so heavy cells can render a placeholder mid-fling and upgrade when the scroll settles. |
| `style` | `StyleProp<ViewStyle>` | Style of the list container. |
| `contentContainerStyle` | `StyleProp<ViewStyle>` | Style forwarded to the scroll content container. |
| `renderScrollComponent` | `(props) => ReactElement` | Provide your own outer ScrollView (e.g. an `Animated.ScrollView`). Forward **every** prop you receive — in particular `maintainVisibleContentPosition` — and keep `removeClippedSubviews` off. |

### Structural components

| Prop | Type | Description |
| --- | --- | --- |
| `ListHeaderComponent` | `ComponentType \| ReactElement \| null` | Rendered above the first item and measured into the scroll math. |
| `ListFooterComponent` | `ComponentType \| ReactElement \| null` | Rendered below the last item and measured into the scroll math. |
| `ListEmptyComponent` | `ComponentType \| ReactElement \| null` | Rendered when `data` is empty. |
| `ItemSeparatorComponent` | `ComponentType<{ leadingItem: T }> \| null` | Rendered between items. |

### Scroll position and anchoring

| Prop | Type | Description |
| --- | --- | --- |
| `initialScrollIndex` | `number` | Mount already positioned at an index. The first rendered window *is* the destination — no scroll flash. |
| `initialScrollOffset` | `number` | Mount already positioned at an offset in dp. |
| `initialScrollAtEnd` | `boolean` | Mount already positioned at the end. |
| `maintainVisibleContentPosition` | `boolean \| { data?, size?, shouldRestorePosition? }` | Keeps what you're looking at where it is. **`size` defaults to on**: the position stays stable while content *above* the viewport re-measures, for every list. `data` (prepend anchoring, needs `keyExtractor`) is opt-in. `true` enables both, `false` disables both. `shouldRestorePosition(item, index)` vetoes anchor candidates — e.g. an optimistic message about to be replaced. |
| `alignItemsAtEnd` | `boolean` | Chat-style: content shorter than the viewport sticks to the bottom. |
| `maintainScrollAtEnd` | `boolean \| { threshold?, animated? }` | Auto-stick to new content while the user is at the end. Footer growth re-sticks, a user drag cancels, and growth during a stick coalesces. |
| `anchoredEndSpace` | `{ anchorIndex, anchorOffset?, anchorMaxSize?, onSizeChanged?, onReady? }` | AI-chat pattern: pads the tail so the anchor message pins to the top of the viewport while the response streams into the pad. Content height stays constant, so nothing jumps. Takes precedence over `maintainScrollAtEnd` while active. |
| `alwaysRender` | `{ top?, bottom?, indices?, keys? }` | Keep specific cells mounted outside the visible window (chat anchors, accessibility targets). Viewability stays geometric, so a pinned cell that is off-screen is not reported as viewable. |

### Sticky headers

| Prop | Type | Description |
| --- | --- | --- |
| `stickyHeaderIndices` | `number[]` | Indices that stick to the top of the viewport. |
| `stickyHeaderConfig` | `{ offset?, hideRelatedCell? }` | `offset` shifts the pinned position in dp; `hideRelatedCell` hides the in-flow cell while its sticky copy is pinned. |
| `onChangeStickyIndex` | `(index: number) => void` | Fires when the currently pinned header changes (`-1` when none). |

### Viewability

| Prop | Type | Description |
| --- | --- | --- |
| `viewabilityConfig` | `{ minimumViewTime?, viewAreaCoveragePercentThreshold?, itemVisiblePercentThreshold?, waitForInteraction? }` | FlatList-compatible viewability configuration. |
| `onViewableItemsChanged` | `({ viewableItems, changed }) => void` | Fires when the viewable set changes. Tokens are `{ item, key, index, isViewable, timestamp }`. |

### Callbacks

| Prop | Type | Description |
| --- | --- | --- |
| `onEndReached` | `({ distanceFromEnd }) => void` | Latched: fires once on entering the threshold, re-arms only after leaving it by a margin, and re-fires when content or data length grew while still inside. |
| `onEndReachedThreshold` | `number` | Fraction of the viewport, default `0.5`. |
| `onStartReached` | `({ distanceFromStart }) => void` | Same latching behaviour at the start of the list. |
| `onStartReachedThreshold` | `number` | Fraction of the viewport, default `0.5`. |
| `onLoad` | `({ elapsedTimeInMs }) => void` | Fires once when the first range renders, with the time since mount. |
| `onFirstVisibleItemChanged` | `({ index, item, key }) => void` | Cheap first-visible signal, deduped by index — much lighter than full viewability tracking. |
| `onItemSizeChanged` | `({ index, size }) => void` | Every measurement flushed to the layout engine. Useful for tuning. |
| `onScroll` | `(e: NativeSyntheticEvent<NativeScrollEvent>) => void` | Standard JS scroll callback. Costs one JS wakeup per tick — under `experimentalUiThreadScroll` prefer `onScrollWorklet`. |
| `onScrollBeginDrag` / `onScrollEndDrag` | `(e) => void` | Drag lifecycle. |
| `onMomentumScrollBegin` / `onMomentumScrollEnd` | `(e) => void` | Momentum lifecycle. |

### UI-thread scrolling

| Prop | Type | Description |
| --- | --- | --- |
| `experimentalUiThreadScroll` | `boolean` | Drive the engine's scroll offset and sticky headers from the UI thread. See [below](#ui-thread-scroll-mode-experimental). |
| `onScrollWorklet` | `(event: ScrollEvent) => void` | Reanimated worklet called per scroll tick on the UI runtime. Must carry the `'worklet'` directive. |
| `scrollOffsetSharedValue` | `SharedValue<number>` | A shared value kept in sync with the scroll offset — drive parallax or collapsing headers from it without touching JS. |

## Imperative handle

```tsx
const ref = useRef<NitroListHandle>(null);

<NitroList ref={ref} {...props} />;

await ref.current?.scrollToIndex({ index: 500, animated: true });
```

### Scrolling

| Method | Description |
| --- | --- |
| `scrollToOffset({ offset, animated? })` | Scroll to an absolute offset in dp. |
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | Scroll to an item. `viewPosition` places it in the viewport (`0` top, `0.5` centre, `1` bottom); `viewOffset` adds a dp nudge. Renders the destination window, then measures and corrects until the offset is exact. |
| `scrollToEnd(animated?)` | Scroll to the end of the content. |
| `scrollIndexIntoView({ index, animated?, viewOffset? })` | Scroll **only if** the item is off-screen, aligning to the nearest edge by direction. |
| `scrollItemIntoView({ item, animated?, viewOffset? })` | Same, resolving the index from the item by identity. |

All of them return a `Promise<void>` that settles when the scroll lands. A superseded command — a newer command, or a user drag taking over — always resolves immediately, so callers never hang. A command issued right after a data change waits for the layout to stabilise (up to 2 stable frames, 800 ms cap) before computing its target.

### Reading layout

| Method | Returns | Description |
| --- | --- | --- |
| `getItemOffset(index)` | `number` | Offset of an item in dp, from the engine. |
| `getItemSize(index)` | `number` | Size of an item in dp (measured, or the current estimate). |
| `getLayout(index)` | `{ x, y, width, height } \| undefined` | Full rect of an item, including its cross-axis placement in grids. |
| `getTotalSize()` | `number` | Total content size in dp. |
| `getFirstItemOffset()` | `number` | Offset where the first item starts — i.e. the measured header size. |
| `getWindowSize()` | `{ width, height }` | Current viewport size. |
| `getAbsoluteLastScrollOffset()` | `number` | Last known scroll offset, including any reported content inset. |
| `getAverageItemSizes()` | `Record<type, { average, count }>` | Per-type running means straight from the native engine. Use it to tune `estimatedItemSize`; untyped lists report under the `''` key. |

### Interop

| Method | Description |
| --- | --- |
| `getScrollableNode()` | The underlying scroll node, for `measure`, `dispatchCommand` and similar. |
| `getNativeScrollRef()` | The native scroll ref, for third-party hooks such as Reanimated's `useScrollOffset`, or an imperative `scrollTo`. |
| `reportContentInset({ bottom })` | Tell the list its scrollable range was extended by a synthetic content inset (keyboard, composer bar) so `scrollToEnd` and max-offset math land correctly. The [`/keyboard`](#keyboard-aware-chat-keyboard) entry point wires this automatically. |

## Exported types

From the root entry point:

`NitroListProps`, `NitroListHandle`, `NitroListRenderItem`, `NitroListRenderTarget`, `NitroListRenderMode`, `NitroListScrollToIndexParams`, `NitroListScrollToOffsetParams`, `NitroListItemLayout`, `NitroListWindowSize`, `NitroListStickyHeaderConfig`, `NitroListMaintainVisibleContentPositionConfig`, `NitroListAlwaysRenderConfig`, `NitroListAnchoredEndSpaceConfig`, `NitroListViewabilityConfig`, `NitroListViewToken`, `NitroListOnViewableItemsChanged`, `NitroListRenderScrollComponent`, `NitroListRenderScrollComponentProps`, `NitroListRangeChangeEvent`, `NitroListPerfSnapshot`, `NitroListScrollToIndexStats`, `LatencyDistributionSnapshot`.

## Sections (`/section-list`)

```tsx
import { NitroSectionList } from '@nhcorrea/react-native-nitro-list/section-list';

<NitroSectionList
  sections={sections}
  estimatedItemSize={64}
  keyExtractor={item => item.id}
  renderItem={({ item, index, section }) => <Row item={item} />}
  renderSectionHeader={({ section }) => <Header title={section.title} />}
/>;
```

Sections are flattened into a typed row union (`header | item | separator | footer`) over a single NitroList, so each row kind gets its own native size statistics for free.

| Prop | Description |
| --- | --- |
| `sections` | `ReadonlyArray<{ data, key? }>`. The section `key` falls back to its index. |
| `renderItem` | `({ item, index, section }) => ReactElement \| null` — `index` is the index **within the section**. |
| `renderSectionHeader` | Rendered once per section. Omitting it removes header rows entirely. |
| `renderSectionFooter` | Rendered after the last item of each section. |
| `ItemSeparatorComponent` | Inserted between items of the same section (never after the last one). |
| `stickySectionHeadersEnabled` | Defaults to `true`. |
| `keyExtractor` / `getItemType` | Operate on your items, not on the flattened rows. |
| `onViewableItemsChanged` | Tokens carry `section` and `sectionIndex` alongside the usual fields. |

Everything else from [`NitroListProps`](#props) is forwarded. The handle is the full [`NitroListHandle`](#imperative-handle) plus:

```tsx
await ref.current?.scrollToLocation({ sectionIndex: 3, itemIndex: 0 });
```

`itemIndex: 0` is the section header, matching React Native's `SectionList`.

The flattening helpers are exported too (`flattenSections`, `flatIndexForLocation`) if you need to map between locations and flat indices yourself.

## Keyboard-aware chat (`/keyboard`)

```tsx
import {
  KeyboardAwareNitroList,
  useKeyboardScrollToEnd,
} from '@nhcorrea/react-native-nitro-list/keyboard';

<KeyboardAwareNitroList
  data={messages}
  renderItem={renderMessage}
  estimatedItemSize={72}
  keyExtractor={m => m.id}
  anchoredEndSpace={{ anchorIndex: lastUserMessageIndex }}
  keyboardLiftBehavior="whenAtEnd"
/>;
```

Requires the optional peer `react-native-keyboard-controller` (>= 1.21.7). The wrapper renders through its `KeyboardChatScrollView`, feeds the `anchoredEndSpace` pad into the keyboard's blank-space floor — so opening the keyboard absorbs into the pad instead of shoving content — and routes content-inset changes into `reportContentInset`.

| Prop | Type | Description |
| --- | --- | --- |
| `keyboardOffset` | `number` | Extra offset above the keyboard in dp. |
| `keyboardLiftBehavior` | `'always' \| 'whenAtEnd' \| 'persistent' \| 'never'` | When the content should lift with the keyboard. |
| `extraContentPadding` | `SharedValue<number>` | Additional padding driven from the UI thread (e.g. a growing composer). |
| `keyboardFreeze` | `boolean \| SharedValue<boolean>` | Temporarily freeze keyboard-driven adjustments. |

Plus every [`NitroListProps`](#props). The ref is a [`NitroListHandle`](#imperative-handle).

`useKeyboardScrollToEnd(ref)` returns a callback that dismisses the keyboard and scrolls to the end in parallel. `getKeyboardControllerModule()` returns the peer module or `null`, so you can branch on availability without a bare `require`.

## UI-thread scroll mode (experimental)

```tsx
<NitroList
  data={items}
  renderItem={renderItem}
  estimatedItemSize={64}
  experimentalUiThreadScroll
  onScrollWorklet={event => {
    'worklet';
    headerOffset.value = event.contentOffset.y; // runs on the UI thread
  }}
/>
```

With `experimentalUiThreadScroll` on, a Reanimated worklet is the only scroll driver: it feeds the native engine and positions sticky headers every frame on the UI thread, and the JS thread wakes **only when the rendered range changes** (plus throttled ticks when `onViewableItemsChanged` is set). During a steady scroll inside the rendered window, your app's JS budget is untouched.

Notes:

- The default outer ScrollView becomes an `Animated.ScrollView` automatically. A custom `renderScrollComponent` must be backed by one.
- `onScrollWorklet` must carry the `'worklet'` directive — automatic workletization does not cross package boundaries.
- A plain JS `onScroll` still works but costs one JS wakeup per tick and receives a minimal synthesized event (`{ nativeEvent: { contentOffset } }`). Dev builds warn about this combination.
- If animated components stutter *during* scroll, look at Reanimated's app-side static feature flags (`DISABLE_COMMIT_PAUSING_MECHANISM`, plus React Native's `preventShadowTreeCommitExhaustion` on RN 0.81+) — only the app can set those.

## Performance monitoring (`/dev`)

```ts
import { NitroListPerfMonitor } from '@nhcorrea/react-native-nitro-list';

NitroListPerfMonitor.enable(); // also resets the counters
// ... interact with the list ...
console.log(NitroListPerfMonitor.getSnapshot());
NitroListPerfMonitor.disable();
```

`getSnapshot()` returns a `NitroListPerfSnapshot` covering:

| Group | Fields | Reads as |
| --- | --- | --- |
| Blank area | `scrollSamples`, `blankSamples`, `blankPxMax`, `blankPxSum` | Empty pixels visible during scroll. `blankSamples: 0` means the window always stayed ahead of the finger. |
| Range | `rangeEvents`, `rangeLatencySamples`, `rangeLatencySumMs`, `rangeLatencyMaxMs`, `rangeLatencyTail` | How long it takes from a scroll dispatch to a new engaged range. The tail is `{ count, max, p50, p95, p99 }`. |
| Mounting | `itemMounts`, `itemUnmounts`, `itemRenders`, `itemContentRenders`, `mountBurst` | Mount churn and how many cells mount in a single burst. |
| Native traffic | `jsiCalls`, `batchFlushes`, `batchPairsSum`, `batchPairsMax`, `layoutVersionBumps` | How much crosses into C++ — measurements batched per flush, and how often the layout version had to move. |
| Startup | `firstRangeLatencyMs` | Time from mount to the first rendered range. |
| `scrollToIndex` | `scrollToIndexStarts`, `scrollToIndexCompletions`, `lastScrollToIndex` | Convergence stats: `{ durationMs, prewarmRestarts, correctionPasses, animated }`. |
| Fling prewarm | `flingPrewarmOutcomes`, `flingPrewarmMisses` | How often a projected fling landing zone was already mounted. |

Instrumentation is compiled only when `__DEV__` is on, when `EXPO_PUBLIC_NITRO_BENCH=1`, or when `globalThis.__NITRO_LIST_PERF__ === true` — set the global before importing the library to measure a release build. In production builds without those, the counters compile out.

The `/dev` entry point also exports:

- `NitroListBenchmarkScreen` — a ready-made harness you can mount on a dev route to run scripted scroll runs and print snapshots.
- `NITRO_LIST_PERF_COMPILED` — whether instrumentation is active in this build.
- `NitroListDevFlags` / `NITRO_LIST_DEV_FLAG_KEYS` — runtime kill-switches for internal scheduling fast-paths, all defaulting to on. Flip one at runtime to isolate a behaviour while debugging, without rebuilding.

## Development warnings

Dev builds print a one-time `[nitro-list]` warning, with the fix, when they detect:

- `data` changing without a `keyExtractor` — every update drops measured sizes back to estimates.
- A duplicate key in the rendered window — React reuses the wrong cell and corrupts measurements.
- A list with data whose viewport still measures 0 — it needs a bounded height.
- `estimatedItemSize` off by more than 40% from the measured mean (after 8 samples) — it suggests the value to use.
- `getFixedItemSize` returning a size that doesn't match what the cell actually measured — the fixed value wins, so following items would overlap or gap.
- `maintainVisibleContentPosition` with a custom `renderScrollComponent` that may not be forwarding the prop.
- `numColumns` combined with `horizontal`.
- A JS `onScroll` under `experimentalUiThreadScroll`.

## Recipes

**Chat with streaming responses**

```tsx
<NitroList
  data={messages}
  renderItem={renderMessage}
  estimatedItemSize={72}
  keyExtractor={m => m.id}
  maintainVisibleContentPosition={{ data: true }}
  alignItemsAtEnd
  maintainScrollAtEnd
  anchoredEndSpace={{ anchorIndex: lastUserMessageIndex }}
  onStartReached={loadOlderMessages}
/>
```

**Feed with uniform rows** — skip measurement entirely:

```tsx
<NitroList
  data={rows}
  renderItem={renderRow}
  estimatedItemSize={88}
  keyExtractor={r => r.id}
  getItemType={r => r.kind}
  getFixedItemSize={(_item, _index, type) => (type === 'row' ? 88 : undefined)}
/>
```

**Mixed content you can't measure up front** — let it learn:

```tsx
<NitroList
  data={rows}
  renderItem={renderRow}
  estimatedItemSize={96}
  keyExtractor={r => r.id}
  getItemType={r => r.kind}
  autoFixedItemSizes
/>
```

**Grid**

```tsx
<NitroList
  data={photos}
  renderItem={renderPhoto}
  estimatedItemSize={120}
  keyExtractor={p => p.id}
  numColumns={3}
  columnWrapperStyle={{ rowGap: 8, columnGap: 8 }}
/>
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Nothing renders | The viewport measures 0 — give the list a bounded height. |
| Blank space during fast scrolls | Raise `drawDistance`, or make cells cheaper with `adaptiveRenderMode`. |
| Scroll position jumps after data updates | Add a `keyExtractor`; for prepends, enable `maintainVisibleContentPosition={{ data: true }}`. |
| Items overlap or leave gaps | `getFixedItemSize` disagrees with the real layout — check the dev warning. |
| Rows re-render on every data update | Pass a stable `itemsAreEqual`, and keep `renderItem` referentially stable. |
| `maintainVisibleContentPosition` does nothing | A custom `renderScrollComponent` isn't forwarding the prop, or has `removeClippedSubviews` on. |
| Animations stutter while scrolling | See the Reanimated feature flags noted in [UI-thread scroll mode](#ui-thread-scroll-mode-experimental). |

## Example app

```sh
npm install
cd example
npm run pod   # iOS
npm run ios   # or: npm run android
```

## Development

- `npm run codegen` — regenerate Nitro bindings (`nitrogen/generated`) after touching `src/NitroListView.nitro.ts`, then build.
- `npm test` — Jest suite for the TS layer.
- `npm run test:cpp` — compiles and runs the C++ `LayoutCore` host tests with ASan/UBSan (no device needed).
- `npm run typecheck` / `npm run build` — TS validation and library output (`lib/`).

## License

MIT © Nathã Corrêa
