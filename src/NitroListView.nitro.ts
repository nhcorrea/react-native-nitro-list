import type {HybridView, HybridViewMethods, HybridViewProps} from 'react-native-nitro-modules';

export interface NitroListViewProps extends HybridViewProps {
  itemCount: number;
  estimatedItemSize: number; // dp
  drawDistance: number; // dp
  // Flattened scalars on purpose: a struct here would be eagerly converted and,
  // on Android, heap-allocated per emission (performance-tips: "Avoid
  // unnecessary objects"). `layoutVersion` is bumped whenever offsets shift —
  // JS uses it to re-position items even when (start, end) didn't move.
  // `offset` is the engine scroll offset (dp) the range was computed at,
  // snapshotted under the same lock as the range. With the UI-thread scroll
  // driver, the worklet pushes offsets natively and JS wakes only on these
  // emissions — carrying the offset here is what lets JS re-sync its
  // bookkeeping without reading a shared value (a blocking JS-thread read).
  onRangeChange?: (start: number, end: number, layoutVersion: number, offset: number) => void;
}

export interface NitroListViewMethods extends HybridViewMethods {
  // Called by JS in response to the consumer's outer ScrollView scrolling.
  setScrollOffset(offset: number): void; // dp
  // Combined scroll + range readback in ONE synchronous JSI call — removes
  // the async onRangeChange hop from the scroll hot path (callbacks are
  // scheduled on the JS thread; a sync return lands in the same tick).
  // Applies the offset, computes the engaged range and, when (start, end,
  // layoutVersion) moved since the last emission/readback, fills `slab`
  // exactly like `fillLayoutSlab` and returns the number of items written.
  // Returns 0 when nothing changed (JS skips all work) and -1 when the slab
  // is too small (grow and retry — the offset was still applied). A returned
  // range is marked as emitted, so onRangeChange stays silent for it and
  // remains the push channel for native-initiated changes only (prop
  // commits, measurement batches).
  setScrollOffsetAndFill(offset: number, slab: ArrayBuffer): number; // dp
  // Called by JS when the outer ScrollView's content area changes size.
  setViewport(width: number, height: number): void; // dp
  // Called by JS from each item's onLayout to report the actual measured size.
  setItemSize(index: number, size: number): void; // dp
  // Batched form of `setItemSize`. Buffer layout (Float64Array view):
  // [idx0, size0, idx1, size1, ...] — sizes in dp. JS coalesces a frame's
  // worth of onLayout reports into one JSI call so the native side can emit
  // a single onRangeChange instead of one per item.
  // `emitRange: false` = silent apply: the caller immediately follows with
  // `setScrollOffsetAndFill`, which returns the range already computed with
  // the fresh sizes in the same tick — the batch's own async emission would
  // be a redundant second delivery. Callers without a follow-up sync fill
  // (the rAF fallback flush) must pass true.
  setItemSizesBatch(pairs: ArrayBuffer, emitRange: boolean): void;
  // maintainVisibleContentPosition variant of setItemSizesBatch: applies the
  // batch and returns how much the anchor item's top offset moved as a result
  // (dp) — mutation and measurement happen under one native lock, so no
  // concurrent change can skew the diff. JS adds the returned delta to the
  // scroll offset to keep the anchored content visually still. Sizes at/below
  // the anchor return 0 by construction; invalid anchor applies the batch
  // normally and returns 0. `emitRange` as in `setItemSizesBatch` — the
  // returned diff is already synchronous, so when a sync fill follows the
  // emission is the only async leftover to suppress.
  setItemSizesBatchAnchored(pairs: ArrayBuffer, anchorIndex: number, emitRange: boolean): number;
  // Forgets every measured size and reverts all items to their best estimate
  // (per-type running mean when available, else estimatedItemSize). Called on
  // structural data changes (keys moved/replaced): index i no longer
  // corresponds to the item that was measured there, so keeping the old sizes
  // would leave offsets/scrollToIndex transiently wrong until every cell
  // happens to remount and re-report.
  resetItemSizes(): void;
  // One uint16 type id per index (Uint16Array view; 0 = untyped). Native keeps
  // an incremental running mean per type, fed by real measurements, and uses
  // it as the estimate for unmeasured items of that type — far offsets become
  // accurate after measuring a single screenful. JS interns getItemType
  // results into these ids and re-sends on data-shape changes.
  setItemTypes(types: ArrayBuffer): void;
  // Seeds per-type mean estimates from JS's cross-mount measurement cache
  // (measurementCache.ts). Buffer layout (Float64Array
  // view): [typeId0, mean0, typeId1, mean1, ...] — means in dp. A seed only
  // lands on a type with no real samples yet and never marks anything as
  // measured: the first real measurement replaces it entirely (the
  // recycling-v1 lesson — synthetic sizes must never masquerade as
  // measurements). Call after setItemTypes on mount so far offsets start
  // near-correct without waiting for measurement sweeps.
  seedTypeMeans(pairs: ArrayBuffer): void;
  // Atomically computes the engaged range and fills `slab` (Float64Array) with
  // [layoutVersion, totalSize, start, end, offset(start), size(start), ...,
  // offset(end), size(end)] — all in dp. Returns the number of items written,
  // or -1 when the buffer is too small (grow and retry). One JSI call replaces
  // 2×range getItemOffset/getItemSize round-trips when hydrating the JS
  // layout cache after a range/layout change.
  fillLayoutSlab(slab: ArrayBuffer): number;
  // Synchronous queries — used by JS during render and imperative API.
  getItemOffset(index: number): number; // dp, top of item from content origin
  getItemSize(index: number): number; // dp
  getTotalSize(): number; // dp
}

export type NitroListView = HybridView<NitroListViewProps, NitroListViewMethods>;
