import CoreGraphics
import Foundation

final class LayoutManager {
  private let core = NitroListLayoutCore()

  struct EngagedRange {
    let start: Int
    let end: Int
    let version: Int
  }


  func setItemCount(_ count: Int) -> Bool {
    core.setItemCount(Int32(count))
  }

  func setEstimate(_ value: CGFloat) -> Bool {
    core.setEstimate(Float(value))
  }

  func setMeasurementEpsilon(_ value: CGFloat) {
    core.setMeasurementEpsilon(Float(value))
  }

  func setDirectionalBuffers(_ enabled: Bool) {
    core.setDirectionalBuffersEnabled(enabled)
  }

  func resetScrollVelocity() {
    core.resetScrollVelocity()
  }

  func setEstimatesFrozen(_ frozen: Bool) -> Bool {
    core.setEstimatesFrozen(frozen)
  }

  func setTypeAverages(_ enabled: Bool) {
    core.setTypeAveragesEnabled(enabled)
  }

  func setItemTypes(_ types: UnsafePointer<UInt16>?, count: Int) {
    core.setItemTypes(types, count: Int32(count))
  }

  func fillLayoutSlab(
    _ out: UnsafeMutablePointer<Double>,
    capacity: Int,
    scrollOffset: CGFloat,
    viewportHeight: CGFloat,
    drawDistance: CGFloat
  ) -> Int {
    Int(
      core.fillLayoutSlab(
        out,
        capacity: Int32(capacity),
        scrollOffset: Float(scrollOffset),
        viewportHeight: Float(viewportHeight),
        drawDistance: Float(drawDistance),
        outputScale: 1
      ))
  }

  func setItemSize(_ index: Int, _ size: CGFloat) -> Bool {
    core.setItemSize(Int32(index), size: Float(size))
  }

  func setItemSizes(_ pairs: UnsafePointer<Double>, count: Int) -> Bool {
    core.setItemSizesBatch(pairs, pairCount: Int32(count))
  }

  func seedTypeMeans(_ pairs: UnsafePointer<Double>, count: Int) -> Bool {
    core.seedTypeMeans(pairs, pairCount: Int32(count))
  }

  func setItemSizesAnchored(_ pairs: UnsafePointer<Double>, count: Int, anchorIndex: Int) -> CGFloat {
    CGFloat(
      core.setItemSizesBatchAnchored(pairs, pairCount: Int32(count), anchorIndex: Int32(anchorIndex)))
  }

  func resetItemSizes() -> Bool {
    core.resetItemSizes()
  }

  func remapItemSizes(_ pairs: UnsafePointer<Double>, count: Int) -> Bool {
    core.remapItemSizes(pairs, pairCount: Int32(count))
  }

  func resetAll() {
    core.resetAll()
  }

  func memoryFootprint() -> Int {
    Int(core.memoryFootprint())
  }


  func getTotalSize() -> CGFloat {
    CGFloat(core.totalSize())
  }

  func getOffset(_ index: Int) -> CGFloat {
    CGFloat(core.offset(for: Int32(index)))
  }

  func getSize(_ index: Int) -> CGFloat {
    CGFloat(core.size(for: Int32(index)))
  }

  func getLayoutVersion() -> Int {
    Int(core.layoutVersion())
  }

  func getEngagedRange(scrollOffset: CGFloat, viewportHeight: CGFloat, drawDistance: CGFloat) -> EngagedRange {
    let range = core.engagedRange(
      withScrollOffset: Float(scrollOffset),
      viewportHeight: Float(viewportHeight),
      drawDistance: Float(drawDistance)
    )
    return EngagedRange(start: Int(range.start), end: Int(range.end), version: Int(range.version))
  }
}
