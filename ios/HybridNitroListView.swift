import NitroModules
import UIKit

final class HybridNitroListView: HybridNitroListViewSpec, RecyclableView {
  private let contentView = NitroListContentView()
  private let layoutManager = LayoutManager()
  private let stateLock = UnfairLock()

  private var scrollOffset: CGFloat = 0
  private var viewportWidth: CGFloat = 0
  private var viewportHeight: CGFloat = 0
  private var drawDistancePt: CGFloat = 0
  private var lastStart: Int = -1
  private var lastEnd: Int = -2
  private var lastVersion: Int = -1
  private var isUpdatingProps = false

  override init() {
    super.init()
    layoutManager.setMeasurementEpsilon(1 / UIScreen.main.scale + 0.01)
    layoutManager.setDirectionalBuffers(true)
    layoutManager.setTypeAverages(true)
  }

  var view: UIView { contentView }

  var memorySize: Int {
    layoutManager.memoryFootprint()
  }


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
      stateLock.withLock {
        lastStart = -1
        lastEnd = -2
        lastVersion = -1
      }
      maybeEmitRange()
    }
  }


  func beforeUpdate() {
    stateLock.withLock { isUpdatingProps = true }
  }

  func afterUpdate() {
    stateLock.withLock { isUpdatingProps = false }
    maybeEmitRange()
  }

  func onDropView() {
    stateLock.withLock { layoutManager.resetAll() }
    onRangeChange = nil
  }

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
        lastStart = start
        lastEnd = end
        lastVersion = version
        return w
      }
    }
    return Double(written)
  }

  func resetScrollVelocity() throws {
    layoutManager.resetScrollVelocity()
  }

  func setEstimatesFrozen(frozen: Bool) throws {
    if layoutManager.setEstimatesFrozen(frozen) {
      maybeEmitRange()
    }
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

  func remapItemSizes(pairs: ArrayBuffer) throws {
    let byteCount = pairs.size
    if byteCount <= 0 { return }
    let pairCount = byteCount / (MemoryLayout<Double>.size * 2)
    if pairCount == 0 { return }
    let changed = pairs.data.withMemoryRebound(to: Double.self, capacity: pairCount * 2) { typed in
      layoutManager.remapItemSizes(UnsafePointer(typed), count: pairCount)
    }
    if changed { maybeEmitRange() }
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
    maybeEmitRange()
  }

  func setItemSizesBatch(pairs: ArrayBuffer, emitRange: Bool) throws {
    let byteCount = pairs.size
    if byteCount <= 0 { return }
    let pairCount = byteCount / (MemoryLayout<Double>.size * 2)
    if pairCount == 0 { return }
    let changed = pairs.data.withMemoryRebound(to: Double.self, capacity: pairCount * 2) { typed in
      layoutManager.setItemSizes(UnsafePointer(typed), count: pairCount)
    }
    if !changed { return }
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


  private func maybeEmitRange() {
    guard let callback = onRangeChange else { return }
    var emission: (start: Int, end: Int, version: Int, offset: CGFloat)?
    stateLock.withLock {
      if isUpdatingProps { return }
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
