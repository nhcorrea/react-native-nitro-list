# react-native-nitro-list

[![npm version](https://img.shields.io/npm/v/@nhcorrea/react-native-nitro-list)](https://www.npmjs.com/package/@nhcorrea/react-native-nitro-list)
[![license](https://img.shields.io/npm/l/@nhcorrea/react-native-nitro-list)](./LICENSE)
[![platforms](https://img.shields.io/badge/platforms-iOS%20%7C%20Android-blue)](#requirements)
[![new architecture](https://img.shields.io/badge/React%20Native-New%20Architecture%20(Fabric)-61dafb)](#requirements)
[![powered by nitro](https://img.shields.io/badge/powered%20by-Nitro%20Modules-ff6b35)](https://nitro.margelo.com)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)](#exported-types)

**Ultra-fast C++ drop-in `FlatList` replacement for React Native — powered by [Nitro Modules](https://nitro.margelo.com).**

Built as a high-performance alternative to `FlatList`, `FlashList`, and `LegendList` for React Native's New Architecture (iOS & Android). The layout engine, prefix-sum index, and cell recycling pool run in shared **C++** with a lightweight **UI-thread Native Host** — plus an **opt-in zero-JS native template renderer** (`nativeTemplate`) for feeds, chats, and grids that stay at **0.0% blank frames even when the JS thread freezes for 100 ms**.

### Highlights

- **Fast out of the box with any React JSX (`renderItem`):** Shared C++ layout and recycling pool paired with a UI-thread Native Host keep JS-thread work minimal, eliminate parent container re-renders on scroll, and deliver fast first-viewport paint.
- **Opt-in Zero-JS Native Templates (`nativeTemplate`):** Render recycled native Android Views (`ViewGroup` + `TextView` + Fresco) and iOS UIKit Views (`UIView` + `UILabel` + `UIImageView`) directly on the UI thread with **zero JS calls during scroll** and **0.0% blank frames even under 100 ms JS stalls**. Toggle on/off per list or via a feature flag (`enabled: true | false`).
- **Only one required peer dependency:** Requires only `react-native-nitro-modules` — **no Reanimated or Worklets required** unless you opt into `experimentalUiThreadScroll` / worklet callbacks.
- **100k+ items & pixel-exact `scrollToIndex`:** Double-precision C++ prefix sums resolve ranges in O(log n) and converge to **0 px error** on dynamic-height 100k lists — every scroll command returns a `Promise`.
- **Production chat, grids & sections:** Native UI-thread `maintainVisibleContentPosition` (**0 px drift** on prepends), `anchoredEndSpace`, [`/keyboard`](#keyboard-aware-chat-keyboard), [`/section-list`](#sections-section-list), multi-column grids with custom `span`, UI-thread sticky headers (`0 dp` lag), and native image prefetching (`getImageUris`).

---

- [Why it's fast](#why-its-fast) · [Requirements](#requirements) · [Installation](#installation) · [Quick start](#quick-start)
- [Native templates (opt-in)](#native-templates-opt-in) · [Native image prefetching](#native-image-prefetching)
- [Coming from FlatList](#coming-from-flatlist) · [Props](#props) · [Imperative handle](#imperative-handle)
- [Sections](#sections-section-list) · [Keyboard-aware chat](#keyboard-aware-chat-keyboard) · [UI-thread scroll mode](#ui-thread-scroll-mode-experimental)
- [Exported types](#exported-types) · [Performance monitoring](#performance-monitoring-dev) · [Recipes](#recipes) · [Troubleshooting](#troubleshooting) · [Benchmarks](#benchmarks)

## Why it's fast

**The layout and recycling pool live in C++, not in React.** Item sizes, prefix offsets, total size, sticky headers, and the slot recycling pool live in a shared C++ core compiled into both iOS and Android (`LayoutCore` + `SlotPool`). Resolving "which items are on screen" is a binary search over block-indexed double-precision prefix sums (O(log n)), so a 100k-item list resolves its range in the same time as a 1k-item list and positions its last item to the exact pixel.

**Native UI-thread scroll host (zero extra dependencies).** With `recycleItems`, `NitroList` automatically attaches a lightweight Nitro Native Host directly to the platform `ScrollView` (`View.OnScrollChangeListener` + `OnPreDrawListener` on Android, `UIScrollView` KVO + `CADisplayLink` on iOS). Scroll events, slot measurements, `maintainVisibleContentPosition` anchoring, sticky header transforms, and cell positioning all execute synchronously on the UI thread before draw. JavaScript only wakes when a slot actually needs to rebind — and only that individual slot re-renders (zero parent re-renders).

**Opt-in zero-JS native templates (`nativeTemplate`).** For ultra-hot feeds, chats, and grids where even React cell reconciliation is too much (or where JS stalls would otherwise cause blank frames), you can pass an opt-in `nativeTemplate` config with a simple `enabled` boolean flag. Cells render directly as recycled native Android Views (Fresco + `TextView`) and iOS UIKit Views (`UIImageView` + `UILabel`) on the UI thread with **zero JS calls during scroll** and **0.0% blank frames even under 100 ms JS stalls**, falling back seamlessly to `renderItem` whenever `enabled: false` or omitted.

**Cells that don't need to change don't re-render.** Cell content is memoized per key, so scrolling reuses mounted cells instead of re-rendering them. With `itemsAreEqual`, a brand-new data array whose items are recreated-but-equal re-renders zero rows.

**Known sizes avoid the initial measurement correction.** `getFixedItemSize` supplies explicit cell sizes. Opt-in `autoFixedItemSizes` learns stable sizes within a list/template and keeps layout verification so later changes can correct the estimate.

**The window is kept ahead of the finger.** The engaged range is extended in the direction of travel, a fling is projected ahead so its landing zone is already mounted, and range edges have hysteresis so a jittery boundary doesn't churn cells every frame. Native image prefetching (`getImageUris`) warms the Fresco/`NSURLSession` bitmap cache ahead of the scroll direction and cancels stale requests on reversal.

**Scroll commands converge instead of guessing.** `scrollToIndex` renders the destination window first, then measures and corrects until the target offset is exact — so it lands precisely even on 100k-item lists with dynamic heights, and every scroll command returns a `Promise` that settles when the scroll actually lands.

## Requirements

- React Native with the **new architecture** enabled (developed against RN 0.86)
- [`react-native-nitro-modules`](https://www.npmjs.com/package/react-native-nitro-modules) 0.37.1+ (the generated bindings come from `nitrogen` 0.37.1)
- Optional: [`react-native-reanimated`](https://www.npmjs.com/package/react-native-reanimated) 4+ and [`react-native-worklets`](https://www.npmjs.com/package/react-native-worklets) 0.10+, **only** if you use `experimentalUiThreadScroll` or `onScrollWorklet` / `scrollOffsetSharedValue`
- Optional: [`react-native-keyboard-controller`](https://www.npmjs.com/package/react-native-keyboard-controller) 1.21.7+, **only** for the [`/keyboard`](#keyboard-aware-chat-keyboard) entry point

## Installation

```sh
npm install @nhcorrea/react-native-nitro-list react-native-nitro-modules
cd ios && pod install
```

> If you also want `experimentalUiThreadScroll`, `onScrollWorklet`, or `scrollOffsetSharedValue`, install the optional peers `react-native-reanimated` and `react-native-worklets` (with the worklets Babel plugin in `babel.config.js`).

## Quick start

```tsx
import { NitroList, type NitroListRenderItem } from '@nhcorrea/react-native-nitro-list';

type Item = { id: string; title: string };

const renderItem: NitroListRenderItem<Item> = ({ item }) => <Row title={item.title} />;
const keyExtractor = (item: Item) => item.id;

function MyList({ items }: { items: Item[] }) {
  return (
    <NitroList
      data={items}
      renderItem={renderItem}
      estimatedItemSize={64}
      keyExtractor={keyExtractor}
      recycleItems
    />
  );
}
```

When `renderItem` needs component state, wrap it in `useCallback` with only what the cells display. See [Callbacks](#callbacks).

Three things matter from the start:

- **`estimatedItemSize` is required.** It drives layout until each cell reports its measured size, after which real measurements take over. Get it roughly right and the first frames are already stable; get it badly wrong and dev builds will tell you (see [Development warnings](#development-warnings)).
- **The list needs a bounded height.** `flex: 1` inside a flex parent, or an explicit height. Nothing renders while the viewport measures 0.
- **Turn on `recycleItems` unless your cells must start from fresh state.** It is off by default, like `FlatList`: every item that enters the window then mounts a new cell and creates its native views, and every item that leaves unmounts one. On a low-end Android device a fast fling through a grid creates views for about a hundred cells and drops frames. With `recycleItems`, scrolling hands mounted cells of the same type (`getItemType`) to the new items instead of creating new ones. State kept inside the component returned by `renderItem` then follows the cell to the next item: derive it from `item`, or reset it with a `key`.

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
| `autoFixedItemSizes` | `boolean` | Opt-in; needs `getItemType`. After at least 32 near-identical samples, a type can use a learned fixed size. The cache distinguishes tagged types, exact cross-axis constraints, font scale and the list/template. It does not share trust across list instances. `onLayout` verifies subsequent sizes and unfreezes a mismatch. Disabled with `overrideItemLayout`, where one type can span different widths. |
| `itemsAreEqual` | `(prev, next, index) => boolean` | A new data array whose items are recreated-but-equal re-renders zero rows. The latest function is used, so it does not need a stable reference. Compare visual content only — the key is already equal by construction. |
| `dataVersion` | `unknown` | Escape hatch for in-place mutation: change this value to force the list to treat `data` as changed even when the array identity did not. |
| `getImageUris` | `(item, index) => string \| readonly string[] \| null \| undefined` | Optional. Supplies image URIs for each item so the native host automatically prefetches lookahead images into Fresco (Android) / `NSURLSession` cache (iOS) in the scroll direction and cancels stale requests on reversal. |
| `imagePrefetchConfig` | `{ lookaheadItems?, width?, height? }` | Optional tuning for `getImageUris` (`lookaheadItems` defaults to `8`; `width`/`height` in dp set native resize bounds). |
| `nativeTemplate` | `NativeTemplateConfig<T>` | **Opt-in** zero-JS native declarative cell renderer (requires `recycleItems`). Renders recycled native Android Views / iOS UIKit views on the UI thread with 0 JS calls during scroll. Toggle on/off at runtime via `nativeTemplate.enabled`. See [Native templates (opt-in)](#native-templates-opt-in). |
| `prepareItem` | `({ item, index, key, signal }) => void \| Promise<void>` | Experimental; needs `recycleItems`. Called for the items just past the rendered window once the list is idle, so the app can warm up what they will need (an `Image.prefetch`, for example). With the prop set, the list calls it instead of mounting those items ahead of time, so they mount when they scroll into the window. At most two calls run at once and 32 items are tracked. `signal` aborts when an item leaves that range, when its data changes or when the list unmounts. Keep the function reference stable: a new function prepares every item again. |

### Callbacks

Cells are keyed by item key. A new function identity never remounts a cell or discards a measurement, so an inline `keyExtractor`, `getItemType`, `getFixedItemSize`, `itemsAreEqual` or `overrideItemLayout` costs nothing extra.

- `renderItem` and `ItemSeparatorComponent` are rendered: a new identity re-renders the content of every mounted cell, as in FlatList. Keep them stable (module scope or `useCallback`). Dev builds warn when `renderItem` changes on many consecutive renders.
- `keyExtractor`, `getItemType`, `getFixedItemSize` and `overrideItemLayout` must be pure functions of `(item, index)`. Their results are read when the data changes, not when the function changes. If a callback starts returning different values for the same data, change `dataVersion`.
- Adding or removing one of these callbacks (for example, passing `getFixedItemSize` where there was none) is a structural change: the list re-measures, keeping mounted cells mounted.

### Layout

| Prop | Type | Description |
| --- | --- | --- |
| `drawDistance` | `number` | How far beyond the viewport to render, in dp. Default `250`. Higher means fewer chances of blank space during fast scrolls at the cost of more mounted cells. At the top or bottom edge, the share that has nowhere to go on one side is rendered on the other. A list that mounts at the top without `getFixedItemSize` commits its first three items alone and fills the window on the next frame, so the first frame with content arrives sooner. |
| `recycleItems` | `boolean` | Reuse mounted cells for items of the same type (`getItemType`) instead of unmounting the cell that left the window and mounting a new one. Default `false`. Scrolling creates far fewer native views. State held inside the component returned by `renderItem` survives when the cell moves to another item: derive it from `item`, or reset it with a `key` on that component. |
| `clipItemsToBounds` | `boolean` | Android only. Clips each item to its own bounds, so items mounted outside the viewport are skipped when a frame is drawn instead of being replayed. Default `true`. Content that overflows an item (a badge with a negative offset, for example) is cut at the item's edge, and touches outside the item's bounds don't reach it. Set `false` if your items draw outside their bounds. |
| `experimentalEagerMount` | `boolean` | Android only, experimental. Mounts each committed Fabric batch as soon as the UI thread is free, instead of at the start of the next frame, so the frame that follows only has to draw. Default `false`. Checked on React Native 0.86; on a version where early mounting is unavailable, the prop does nothing. While a list with the prop is mounted, every pending batch in the app is mounted early, in the same order. No effect on iOS, where Fabric already mounts this way. |
| `horizontal` | `boolean` | Row layout: offsets, measurements, sticky headers and viewability all run on the x axis (cells report their width). |
| `numColumns` | `number` | Grid layout. Rows advance by their tallest cell. Changing the value re-measures everything, since cell width changed. Ignored when `horizontal`. |
| `overrideItemLayout` | `(layout: { span }, item, index) => void` | Set a per-item column span by mutating `layout.span`. |
| `columnWrapperStyle` | `{ rowGap?, columnGap? }` | Grid gaps. Cross-axis placement is percentage-based, so rotation reflows for free. |
| `snapToIndices` | `readonly number[]` | Snap points computed live from the engine's offsets, so they track real measurements. |
| `adaptiveRenderMode` | `boolean` | Opt-in. `renderItem` receives `renderMode: 'normal' \| 'fast'` driven by a Schmitt trigger on scroll velocity, so heavy cells can render a placeholder mid-fling and upgrade when the scroll settles. |
| `style` | `StyleProp<ViewStyle>` | Style of the list container. |
| `contentContainerStyle` | `StyleProp<ViewStyle>` | Style forwarded to the scroll content container. Main-axis padding (`paddingTop`/`paddingBottom` when vertical, `paddingStart`/`paddingLeft`/`paddingEnd`/`paddingRight` when horizontal, plus the `paddingVertical`/`paddingHorizontal`/`padding` fallbacks) is read back into the scroll math, so sticky headers, `scrollToIndex` and viewability stay aligned with what you see. |
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
| `anchoredEndSpace` | `{ anchorIndex, anchorOffset?, anchorMaxSize?, onSizeChanged?, onReady? }` | Pads the tail so the anchor message can pin to the top while a response streams. Takes precedence over `maintainScrollAtEnd`. The entire tail from the anchor is mounted for measurement; use a recent anchor to keep that cost bounded. |
| `alwaysRender` | `{ top?, bottom?, indices?, keys? }` | Keep specific cells mounted outside the visible window (chat anchors, accessibility targets). Viewability stays geometric, so a pinned cell that is off-screen is not reported as viewable. |

### Sticky headers

| Prop | Type | Description |
| --- | --- | --- |
| `stickyHeaderIndices` | `number[]` | Indices that stick to the top of the viewport. |
| `stickyHeaderConfig` | `{ offset?, hideRelatedCell?, size? }` | `offset` shifts the pinned position in dp; `hideRelatedCell` hides the in-flow cell while its sticky copy is pinned; `size` pins the overlay height in dp instead of measuring it (useful when the cell carries a trailing gap the pinned copy drops). |
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
| `getLayout(index)` | `{ x, y, width, height } \| undefined` | Cell slot relative to the item container, including grid spans/placement. Excludes outer padding/header and rowGap; grid width includes its internal column-gap padding. Unmeasured dimensions are estimates. |
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

`NitroListProps`, `NitroListHandle`, `NitroListRenderItem`, `NitroListRenderTarget`, `NitroListRenderMode`, `NitroListScrollToIndexParams`, `NitroListScrollToOffsetParams`, `NitroListItemLayout`, `NitroListWindowSize`, `NitroListStickyHeaderConfig`, `NitroListMaintainVisibleContentPositionConfig`, `NitroListAlwaysRenderConfig`, `NitroListAnchoredEndSpaceConfig`, `NitroListViewabilityConfig`, `NitroListViewToken`, `NitroListOnViewableItemsChanged`, `NitroListRenderScrollComponent`, `NitroListRenderScrollComponentProps`, `NitroListRangeChangeEvent`, `NitroListImagePrefetchConfig`, `NitroListPerfSnapshot`, `NitroListScrollToIndexStats`, `LatencyDistributionSnapshot`, `NativeTemplateConfig`, `NativeTemplateNode`, `NativeTemplateBoxNode`, `NativeTemplateTextNode`, `NativeTemplateImageNode`, `NativeTemplateFieldValue`, `NativeTemplateAlign`, `NativeTemplateFontWeight`, `NativeTemplateResizeMode`.

Also exported from the root entry point: `resolveNativeImageUri`, `prefetchNitroListImages`, `cancelNitroListImagePrefetch`.

## Native templates (opt-in)

By default, `NitroList` renders any arbitrary React JSX through `renderItem` while running layout, recycling, measurements, MVCP, and positioning natively via the Nitro Native Host.

When you want **maximum native throughput** on data-driven feeds, chats, or photo grids — **zero React/JS calls during scroll** and **0.0% blank frames even when the JS thread is blocked for 100 ms** — you can opt into `nativeTemplate` (requires `recycleItems`).

### Feature-flag toggle (`enabled`)

`nativeTemplate` is completely **opt-in** and includes a built-in `enabled` flag (defaults to `true`). You can toggle it per list, via remote config, or with a simple feature flag — whenever `enabled` is `false` (or `nativeTemplate` is omitted), `NitroList` falls back seamlessly to your standard React `renderItem`:

```tsx
import { useMemo } from 'react';
import {
  NitroList,
  resolveNativeImageUri,
  type NativeTemplateConfig,
} from '@nhcorrea/react-native-nitro-list';

const USE_NATIVE_TEMPLATES = true; // toggle on/off per screen or via feature flag

type Post = {
  id: string;
  author: string;
  avatar: string;
  body: string;
  photo?: string;
  aspectRatio?: number;
};

function Feed({ posts, onOpenPost }: { posts: Post[]; onOpenPost: (post: Post) => void }) {
  const nativeTemplate = useMemo<NativeTemplateConfig<Post>>(
    () => ({
      enabled: USE_NATIVE_TEMPLATES,
      getTemplateKey: (item) => (item.photo ? 'photo' : 'text'),
      onPress: (index, action) => {
        if (action === 'open') onOpenPost(posts[index]!);
      },
      templates: {
        text: {
          type: 'column',
          backgroundColor: '#ffffff',
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: '#e3e8ee',
          pressAction: 'open',
          children: [
            {
              type: 'row',
              alignItems: 'center',
              gap: 10,
              children: [
                { type: 'image', uriField: 'avatar', width: 40, height: 40, borderRadius: 20 },
                { type: 'text', textField: 'author', fontSize: 15, fontWeight: '600', color: '#14232f' },
              ],
            },
            { type: 'text', textField: 'body', fontSize: 15, lineHeight: 21, color: '#22313d' },
          ],
        },
        photo: {
          type: 'column',
          backgroundColor: '#ffffff',
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: '#e3e8ee',
          pressAction: 'open',
          children: [
            {
              type: 'row',
              alignItems: 'center',
              gap: 10,
              children: [
                { type: 'image', uriField: 'avatar', width: 40, height: 40, borderRadius: 20 },
                { type: 'text', textField: 'author', fontSize: 15, fontWeight: '600', color: '#14232f' },
              ],
            },
            { type: 'text', textField: 'body', fontSize: 15, lineHeight: 21, color: '#22313d' },
            {
              type: 'image',
              uriField: 'photo',
              aspectRatioField: 'aspectRatio',
              borderRadius: 10,
              backgroundColor: '#d6dde4',
              resizeMode: 'cover',
            },
          ],
        },
      },
      extractFields: (item) => ({
        author: item.author,
        avatar: resolveNativeImageUri(item.avatar),
        body: item.body,
        photo: item.photo ? resolveNativeImageUri(item.photo) : null,
        aspectRatio: item.aspectRatio ?? 16 / 9,
      }),
    }),
    [posts, onOpenPost],
  );

  return (
    <NitroList
      data={posts}
      renderItem={renderPostFallback}
      nativeTemplate={nativeTemplate}
      estimatedItemSize={220}
      keyExtractor={(p) => p.id}
      getItemType={(p) => (p.photo ? 'photo' : 'text')}
      recycleItems
    />
  );
}
```

How it works under the hood:
- **Zero JS during scroll:** Template nodes (`column`, `row`, `box`, `text`, `image`) are compiled once into a compact schema and flat data fields are packed into little-endian binary `ArrayBuffer` chunks with string deduplication. Native Android (`ViewGroup` + `TextView` + Fresco `GenericDraweeView`) and iOS UIKit (`UIView` + `UILabel` + `UIImageView` + `NSCache`) recycle, bind, measure, run MVCP, prefetch images, and position cells synchronously on the UI thread before draw.
- **Scales to 100k+ items & live chat prepends:** Lists up to 4,096 items pack synchronously in ~2 ms; larger datasets pack only the head and tail synchronously and pull middle chunks on-demand with bounded memory. Pure prepends and appends shift existing native chunks in O(1) and pack only the newly inserted items.
- **When to use `renderItem` vs `nativeTemplate`:** Keep standard `renderItem` JSX for cells with interactive inputs, complex animations, SVG/custom native modules, or third-party React components. Opt into `nativeTemplate` for high-volume data-driven feeds, chat timelines, and image grids where you want native RecyclerView/UICollectionView-class efficiency and immunity to JS-thread stalls.

> **Verified on real low-end Android hardware (Redmi 10C, Android 13, 5 paired repetitions):** With `nativeTemplate` enabled on dynamic feed, 3-column photo grid, chat reversal, chat prepend, and 100k jump scenarios, `NitroList` cuts JS instructions **10×–31×** (to 16–30 M during flings), cuts UI-thread work **30%–53%**, cuts total process instructions **1.8×–6.1×**, and maintains **0.0% blank frames (5/5)** even under 100 ms JS-thread freezes.

## Native image prefetching

When rendering standard React cells (`renderItem`) with `recycleItems`, you can pass `getImageUris` (and optional `imagePrefetchConfig`) so the native host prefetches lookahead images into Fresco (Android) / `NSURLSession` cache (iOS) in the direction of scroll and cancels obsolete fetches when the user reverses direction:

```tsx
<NitroList
  data={photos}
  renderItem={renderPhoto}
  estimatedItemSize={240}
  keyExtractor={(p) => p.id}
  recycleItems
  getImageUris={(item) => [item.avatarUrl, item.photoUrl]}
  imagePrefetchConfig={{ lookaheadItems: 10, width: 360, height: 240 }}
/>
```

## Sections (`/section-list`)

```tsx
import { NitroSectionList } from '@nhcorrea/react-native-nitro-list/section-list';

const keyExtractor = (item: Item) => item.id;
const renderItem = ({ item }: { item: Item }) => <Row item={item} />;
const renderSectionHeader = ({ section }: { section: Section }) => <Header title={section.title} />;

<NitroSectionList
  sections={sections}
  estimatedItemSize={64}
  keyExtractor={keyExtractor}
  renderItem={renderItem}
  renderSectionHeader={renderSectionHeader}
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
- Turning `experimentalUiThreadScroll` on or off after mount remounts the scroll component, so its scroll handler is registered with Reanimated from the start.
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
- `NitroListDevFlags` / `NITRO_LIST_DEV_FLAG_KEYS` — runtime switches for debugging. Keep the defaults in production.

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
- `renderItem` changing identity on 10 consecutive renders — every mounted cell re-renders each time.
- `recycleItems` left unset on a list that has mounted 100 new cells after its first window — every item that enters the window creates its native views from scratch. Set `recycleItems`, or `recycleItems={false}` to keep fresh cells and silence it.

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
| Frames drop on Android when many text cells mount at once | Text layout on the UI thread. Turn on `recycleItems`, and consider React Native's prepared text layout (`enablePreparedTextLayout` with `enableAndroidTextMeasurementOptimizations`), which moves text layout off the mount. NitroList works with these flags; they are app-wide React Native feature flags in 0.86–0.88 and already on by default in React Native's main branch. |

## Benchmarks

To validate real-world behavior under tight CPU/GPU budgets, we run paired benchmarks on a low-end Android device (**Redmi 10C**, Snapdragon 680, Android 13, `arm64-v8a` release APK) across **5 alternating repetitions** per scenario using Linux `simpleperf` hardware instruction counters (`JS`, `UI`, `Total` in millions of retired instructions), process CPU time (`cpuMs`), Android `FrameTimeline` (`hitchTimeRatio`), and mounted-row visual coverage (`blank%`). Reference libraries (**FlashList 2.3.3** and **LegendList 3.7.1**) are configured with each library's documented recommended props (`recycleItems`, `getItemType`, `estimatedItemSize`).

| Scenario | NitroList *(JSX default)* | NitroList *(`nativeTemplate` opt-in)* | FlashList 2.3.3 | LegendList 3.7.1 |
| --- | --- | --- | --- | --- |
| **Dynamic feed fling** *(1k mixed text + photos)* | **120 M JS** · 798 M tot · 1,700 ms CPU · **0.0% blank** | **26 M JS** · **566 M tot** · **1,490 ms CPU** · **0.0% blank** | 474 M JS · 1,208 M tot · 2,020 ms CPU · 0.0% blank | 478 M JS · 1,184 M tot · 2,010 ms CPU · 0.0% blank |
| **Feed under 100 ms JS freeze** *(`busy100`)* | **2,494 M JS** · 3,190 M tot · 2,530 ms CPU · **2.6% blank** | **2,386 M JS** · **2,932 M tot** · **2,360 ms CPU** · **0.0% blank (5/5)** | 2,714 M JS · 3,426 M tot · 2,660 ms CPU · 2.6%–3.9% blank | 2,768 M JS · 3,466 M tot · 2,690 ms CPU · 3.2% blank |
| **3-column photo grid fling** *(dynamic captions)* | **324 M JS** · 1,312 M tot · 2,180 ms CPU · **0.0% blank** | **30 M JS** · **932 M tot** · **1,900 ms CPU** · **0.0% blank** | 778 M JS · 1,674 M tot · 2,290 ms CPU · 0.0% blank | 932 M JS · 1,862 M tot · 2,390 ms CPU · 0.0% blank |
| **Chat reversal fling** *(variable bubbles)* | **52 M JS** · 394 M tot · 740 ms CPU · **17.5 hitch** | **16 M JS** · **310 M tot** · **670 ms CPU** · **17.8 hitch** | 312 M JS · 608 M tot · 880 ms CPU · 35.0 hitch | 156 M JS · 480 M tot · 810 ms CPU · 38.3 hitch |
| **Live chat prepend** *(MVCP anchored)* | **70 M JS** · **446 M tot** · 1,080 ms CPU · **0.0% blank** | 286 M JS · 646 M tot · **1,060 ms CPU** · **0.0% blank (5/5)** | 460 M JS · 828 M tot · 1,120 ms CPU · 0.0% blank | 412 M JS · 896 M tot · 1,790 ms CPU · 0.0% blank |
| **100,000-item dynamic jump** *(`g8`)* | **92 M JS** · **486 M tot** · **890 ms CPU** · **5/5 PASS (0 px)** | 820 M JS · **106 M UI** · 900 ms CPU · **5/5 PASS (0 px)** | 2,080 M JS · 2,454 M tot · 1,340 ms CPU · 5/5 PASS (0 px) | 5,870 M JS · 6,336 M tot · 3,160 ms CPU · 0/5 FAIL *(1,596 px off)* |
| **Multi-target `scrollToIndex`** *(20 targets)* | **166 M JS** · **1.29 s** · **330 ms CPU** · **0 px (5/5 PASS)** | — | 876 M JS · 2.22 s · 910 ms CPU · 0 px (5/5 PASS) | 556 M JS · 1.11 s · 390 ms CPU · 0/5 FAIL *(300 px off)* |

> Lower is better for instructions, CPU, hitch ratio, blank%, and target error. Results naturally vary with device tier, cell tree complexity, and React Native version — always profile your own screens.

### Architecture at a glance

| Capability | NitroList | FlashList v2 | LegendList | FlatList |
| --- | :---: | :---: | :---: | :---: |
| C++ layout engine & recycling pool (JSI / Nitro) | Yes | JS / native view | JS | JS |
| UI-thread scroll, measurement, MVCP & sticky host | Yes (built-in) | Partial | Partial | No |
| Opt-in Zero-JS native cell templates (`nativeTemplate`) | Yes (Android + iOS) | No | No | No |
| Native directional image prefetch (`getImageUris`) | Yes (Fresco / URLSession) | No | No | No |
| Works without Reanimated / Worklets | Yes | Yes | Yes | Yes |
| Convergent `Promise` `scrollToIndex` on 100k dynamic items | Yes (0 px) | Yes | Approximate | Needs `getItemLayout` |

## Development

- [`example/`](./example) — a small app with a feed, a grid, sections and a chat. Its README shows how to run it.
- `npm run codegen` — regenerate Nitro bindings (`nitrogen/generated`) after touching `src/NitroListEngine.nitro.ts`, then build.
- `npm test` — Jest suite for the TS layer.
- `npm run test:engine` — tests the production engine and generated Nitro interface with ASan/UBSan; only the host transport is stubbed.
- `npm run test:cpp` — compiles and runs the C++ `LayoutCore` host tests with ASan/UBSan (no device needed).
- `npm run typecheck` / `npm run build` — TS validation and library output (`lib/`).
- `npm run verify:package` — checks the tarball npm would publish (entry points and every relative import resolve inside it).

Releases are automated from commit messages (conventional commits + semantic-release).

## License

MIT © Nathã Corrêa
