import NitroModules
import UIKit

/// iOS HybridView for `NitroListView`. Thin glue between JS (Nitro/JSI) and
/// the shared C++ `LayoutCore` (via the `LayoutManager` adapter). Mirrors
/// `HybridNitroListView.kt` 1:1 (the Android reference), minus the dp↔px
/// conversion — iOS uses points uniformly and the JS↔native API talks in
/// points.
///
/// Threading (guides/view-components.md: thread-safety is ours to ensure):
/// - Prop setters + `beforeUpdate`/`afterUpdate` run on the main thread
///   (Fabric `updateProps`).
/// - Hybrid methods run synchronously on the JS thread via JSI — and, with
///   the experimental UI-thread scroll driver, `setScrollOffset` can also
///   arrive from the UI-thread worklet runtime.
/// All mutable wrapper state is guarded by `stateLock`. Lock ordering:
/// stateLock → LayoutCore's mutex (never the reverse — the core never calls
/// back into the wrapper). `onRangeChange` is NEVER invoked while holding the
/// lock (snapshot, unlock, call).
final class HybridNitroListView: HybridNitroListViewSpec, RecyclableView {
  private let contentView = NitroListContentView()
  private let layoutManager = LayoutManager()
  private let stateLock = UnfairLock()

  // ---- State guarded by stateLock (points) ----------------------------------
  private var scrollOffset: CGFloat = 0
  private var viewportWidth: CGFloat = 0
  private var viewportHeight: CGFloat = 0
  private var drawDistancePt: CGFloat = 0
  // Last range emitted to JS — used to skip duplicate callbacks.
  private var lastStart: Int = -1
  private var lastEnd: Int = -2
  private var lastVersion: Int = -1
  // True between beforeUpdate() and afterUpdate(): setters skip per-prop range
  // recomputation and afterUpdate() does it once for the whole commit.
  private var isUpdatingProps = false

  override init() {
    super.init()
    // ≈1 physical pixel: measurement deltas below this are layout jitter, not
    // real size changes (they survive the 1/8pt octave on 2x/3x displays).
    layoutManager.setMeasurementEpsilon(1 / UIScreen.main.scale + 0.01)
    // Same total draw budget, redistributed toward the scroll direction
    // (1.5×/0.5×). Single-line rollback if it ever misbehaves.
    layoutManager.setDirectionalBuffers(true)
    // Per-type running means (fed by real measurements) replace the global
    // estimate for unmeasured items. Single-line rollback likewise.
    layoutManager.setTypeAverages(true)
  }

  var view: UIView { contentView }

  /// Native weight of the layout arrays — lets the JS GC see the real size of
  /// large lists instead of ~0 bytes (performance-tips: memorySize).
  var memorySize: Int {
    layoutManager.memoryFootprint()
  }

  // MARK: - Props (set on main thread by Fabric)

  var itemCount: Double = 0 {
    didSet {
      _ = layoutManager.setItemCount(max(0, Int(itemCount)))
      maybeEmitRange()
    }
  }

  var estimatedItemSize: Double = 0 {
    didSet {
      _ = layoutManager.setEstimate(CGFloat(estimatedItemSize))
      maybeEmitRange()
    }
  }

  var drawDistance: Double = 0 {
    didSet {
      stateLock.withLock { drawDistancePt = CGFloat(drawDistance) }
      maybeEmitRange()
    }
  }

  var onRangeChange: ((Double, Double, Double, Double) -> Void)? {
    didSet {
      // Re-emit the current range so a freshly-mounted JS subscriber catches up.
      stateLock.withLock {
        lastStart = -1
        lastEnd = -2
        lastVersion = -1
      }
      maybeEmitRange()
    }
  }

  // MARK: - View lifecycle (Fabric)

  func beforeUpdate() {
    stateLock.withLock { isUpdatingProps = true }
  }

  func afterUpdate() {
    // One engaged-range computation per props commit instead of one per dirty
    // setter (guides/view-components.md: batch prop changes here).
    stateLock.withLock { isUpdatingProps = false }
    maybeEmitRange()
  }

  func onDropView() {
    // Unmount: release the layout arrays and the strong ref to the JS callback.
    stateLock.withLock { layoutManager.resetAll() }
    onRangeChange = nil
  }

  /// Fabric view recycling (opt-in via `RecyclableView`): the next use must
  /// behave exactly like a fresh instance — stale ranges/sizes would show the
  /// previous list's geometry. Wrapper-set core config (epsilon, directional
  /// buffers, type averages) survives; props are re-applied by Fabric.
  func prepareForRecycle() {
    stateLock.withLock {
      layoutManager.resetAll()
      scrollOffset = 0
      viewportWidth = 0
      viewportHeight = 0
      lastStart = -1
      lastEnd = -2
      lastVersion = -1
    }
  }

  // MARK: - Hybrid methods (called from JS thread via JSI)

  func setScrollOffset(offset: Double) throws {
    let value = CGFloat(offset)
    let changed = stateLock.withLock { () -> Bool in
      if value == scrollOffset { return false }
      scrollOffset = value
      return true
    }
    if changed { maybeEmitRange() }
  }

  func setScrollOffsetAndFill(offset: Double, slab: ArrayBuffer) throws -> Double {
    let capacity = slab.size / MemoryLayout<Double>.size
    if capacity == 0 { return -1 }
    let value = CGFloat(offset)
    // One stateLock acquisition covers offset write + fill + dedupe: no
    // concurrent mutation can interleave between "what range did I get" and
    // "what range did I mark as delivered". Slab layout (fillLayoutSlab):
    // [layoutVersion, totalSize, start, end, (offset, size)…].
    let written = slab.data.withMemoryRebound(to: Double.self, capacity: capacity) { typed -> Int in
      stateLock.withLock { () -> Int in
        scrollOffset = value
        let w = layoutManager.fillLayoutSlab(
          typed,
          capacity: capacity,
          scrollOffset: scrollOffset,
          viewportHeight: viewportHeight,
          drawDistance: drawDistancePt
        )
        if w < 0 { return -1 }
        let version = Int(typed[0])
        let start = Int(typed[2])
        let end = Int(typed[3])
        if start == lastStart && end == lastEnd && version == lastVersion { return 0 }
        // Mark as delivered — onRangeChange must stay silent for this range.
        lastStart = start
        lastEnd = end
        lastVersion = version
        return w
      }
    }
    return Double(written)
  }

  func setViewport(width: Double, height: Double) throws {
    let w = CGFloat(width)
    let h = CGFloat(height)
    let changed = stateLock.withLock { () -> Bool in
      if w == viewportWidth && h == viewportHeight { return false }
      viewportWidth = w
      viewportHeight = h
      return true
    }
    if changed { maybeEmitRange() }
  }

  func resetItemSizes() throws {
    if layoutManager.resetItemSizes() {
      maybeEmitRange()
    }
  }

  func setItemTypes(types: ArrayBuffer) throws {
    let count = types.size / MemoryLayout<UInt16>.size
    if count == 0 {
      layoutManager.setItemTypes(nil, count: 0)
    } else {
      types.data.withMemoryRebound(to: UInt16.self, capacity: count) { typed in
        layoutManager.setItemTypes(UnsafePointer(typed), count: count)
      }
    }
    // Unmeasured sizes may have been re-resolved against the new types.
    maybeEmitRange()
  }

  func seedTypeMeans(pairs: ArrayBuffer) throws {
    let byteCount = pairs.size
    if byteCount <= 0 { return }
    let pairCount = byteCount / (MemoryLayout<Double>.size * 2)
    if pairCount == 0 { return }
    let changed = pairs.data.withMemoryRebound(to: Double.self, capacity: pairCount * 2) { typed in
      layoutManager.seedTypeMeans(UnsafePointer(typed), count: pairCount)
    }
    // Unmeasured sizes re-resolved against the seeded means.
    if changed { maybeEmitRange() }
  }

  func fillLayoutSlab(slab: ArrayBuffer) throws -> Double {
    let capacity = slab.size / MemoryLayout<Double>.size
    if capacity == 0 { return -1 }
    let (offset, viewport, draw) = stateLock.withLock {
      (scrollOffset, viewportHeight, drawDistancePt)
    }
    let written = slab.data.withMemoryRebound(to: Double.self, capacity: capacity) { typed in
      layoutManager.fillLayoutSlab(
        typed,
        capacity: capacity,
        scrollOffset: offset,
        viewportHeight: viewport,
        drawDistance: draw
      )
    }
    return Double(written)
  }

  func setItemSize(index: Double, size: Double) throws {
    let changed = layoutManager.setItemSize(Int(index), CGFloat(size))
    if !changed { return }
    // No `setNeedsLayout` here on purpose. The inner host view's height is
    // driven by JS (`style={{ height: hybrid.getTotalSize() }}`), which
    // re-renders when the range/layoutVersion changes.
    maybeEmitRange()
  }

  func setItemSizesBatch(pairs: ArrayBuffer, emitRange: Bool) throws {
    // Buffer is non-owning (JS-allocated). We read it synchronously, so its
    // memory is valid for the duration of this call — no copy needed.
    let byteCount = pairs.size
    if byteCount <= 0 { return }
    let pairCount = byteCount / (MemoryLayout<Double>.size * 2)
    if pairCount == 0 { return }
    let changed = pairs.data.withMemoryRebound(to: Double.self, capacity: pairCount * 2) { typed in
      layoutManager.setItemSizes(UnsafePointer(typed), count: pairCount)
    }
    if !changed { return }
    // Silent apply (emitRange=false): the caller follows with
    // setScrollOffsetAndFill, whose version check picks the new sizes up —
    // skipping here must NOT touch lastStart/End/Version, or that dedupe
    // would wrongly swallow the delivery.
    if emitRange { maybeEmitRange() }
  }

  func setItemSizesBatchAnchored(pairs: ArrayBuffer, anchorIndex: Double, emitRange: Bool) throws -> Double {
    let byteCount = pairs.size
    if byteCount <= 0 { return 0 }
    let pairCount = byteCount / (MemoryLayout<Double>.size * 2)
    if pairCount == 0 { return 0 }
    let diff = pairs.data.withMemoryRebound(to: Double.self, capacity: pairCount * 2) { typed in
      layoutManager.setItemSizesAnchored(
        UnsafePointer(typed), count: pairCount, anchorIndex: Int(anchorIndex))
    }
    if emitRange { maybeEmitRange() }
    return Double(diff)
  }

  func getItemOffset(index: Double) throws -> Double {
    Double(layoutManager.getOffset(Int(index)))
  }

  func getItemSize(index: Double) throws -> Double {
    Double(layoutManager.getSize(Int(index)))
  }

  func getTotalSize() throws -> Double {
    Double(layoutManager.getTotalSize())
  }

  // MARK: - Range emission

  private func maybeEmitRange() {
    // Single read of the callback ref; never invoked under stateLock.
    guard let callback = onRangeChange else { return }
    // Offset snapshotted under the same lock as the range — JS re-syncs its
    // scroll bookkeeping from it when the UI-thread worklet is the driver.
    var emission: (start: Int, end: Int, version: Int, offset: CGFloat)?
    stateLock.withLock {
      if isUpdatingProps { return } // afterUpdate() emits once for the batch
      let range = layoutManager.getEngagedRange(
        scrollOffset: scrollOffset,
        viewportHeight: viewportHeight,
        drawDistance: drawDistancePt
      )
      if range.start == lastStart && range.end == lastEnd && range.version == lastVersion {
        return
      }
      lastStart = range.start
      lastEnd = range.end
      lastVersion = range.version
      emission = (range.start, range.end, range.version, scrollOffset)
    }
    if let emission {
      callback(
        Double(emission.start), Double(emission.end), Double(emission.version),
        Double(emission.offset))
    }
  }
}
