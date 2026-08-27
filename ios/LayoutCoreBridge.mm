#import "LayoutCoreBridge.h"

#import "../cpp/LayoutCore.hpp"

using margelo::nitro::nitrolist::LayoutCore;

@implementation NitroListLayoutCore {
  LayoutCore _core;
}

- (BOOL)setItemCount:(int32_t)count {
  return _core.setItemCount(count);
}

- (BOOL)setEstimate:(float)value {
  return _core.setEstimate(value);
}

- (void)setMeasurementEpsilon:(float)value {
  _core.setMeasurementEpsilon(value);
}

- (void)setDirectionalBuffersEnabled:(BOOL)enabled {
  _core.setDirectionalBuffers(enabled);
}

- (void)resetScrollVelocity {
  _core.resetScrollVelocity();
}

- (BOOL)setEstimatesFrozen:(BOOL)frozen {
  return _core.setEstimatesFrozen(frozen);
}

- (void)setTypeAveragesEnabled:(BOOL)enabled {
  _core.setTypeAverages(enabled);
}

- (void)setItemTypes:(nullable const uint16_t *)types count:(int32_t)count {
  _core.setItemTypes(types, count);
}

- (void)setColumnCount:(int32_t)columns {
  _core.setColumnCount(columns);
}

- (BOOL)setItemSpans:(nullable const uint16_t *)spans count:(int32_t)count {
  return _core.setItemSpans(spans, count);
}

- (int32_t)fillLayoutSlab:(double *)out
                 capacity:(int32_t)capacityDoubles
             scrollOffset:(float)scrollOffset
           viewportHeight:(float)viewportHeight
             drawDistance:(float)drawDistance
              outputScale:(float)outputScale {
  return _core.fillLayoutSlab(out, capacityDoubles, scrollOffset, viewportHeight, drawDistance,
                              outputScale);
}

- (int32_t)fillTypeStats:(double *)out
                capacity:(int32_t)capacityDoubles
             outputScale:(float)outputScale {
  return _core.fillTypeStats(out, capacityDoubles, outputScale);
}

- (BOOL)setItemSize:(int32_t)index size:(float)size {
  return _core.setItemSize(index, size);
}

- (BOOL)setItemSizesBatch:(const double *)pairs pairCount:(int32_t)pairCount {
  return _core.setItemSizes(pairs, pairCount, 1.0f);
}

- (BOOL)seedTypeMeans:(const double *)pairs pairCount:(int32_t)pairCount {
  return _core.seedTypeMeans(pairs, pairCount, 1.0f);
}

- (float)setItemSizesBatchAnchored:(const double *)pairs
                         pairCount:(int32_t)pairCount
                       anchorIndex:(int32_t)anchorIndex {
  return _core.setItemSizesAnchored(pairs, pairCount, 1.0f, anchorIndex);
}

- (BOOL)resetItemSizes {
  return _core.resetItemSizes();
}

- (BOOL)remapItemSizes:(const double *)pairs pairCount:(int32_t)pairCount {
  return _core.remapItemSizes(pairs, pairCount);
}

- (void)resetAll {
  _core.resetAll();
}

- (NSUInteger)memoryFootprint {
  return _core.getMemoryFootprint();
}

- (float)totalSize {
  return _core.getTotalSize();
}

- (float)offsetForIndex:(int32_t)index {
  return _core.getOffset(index);
}

- (float)sizeForIndex:(int32_t)index {
  return _core.getSize(index);
}

- (int32_t)layoutVersion {
  return _core.getLayoutVersion();
}

- (NitroListEngagedRange)engagedRangeWithScrollOffset:(float)scrollOffset
                                       viewportHeight:(float)viewportHeight
                                         drawDistance:(float)drawDistance {
  const LayoutCore::EngagedRange range =
      _core.getEngagedRange(scrollOffset, viewportHeight, drawDistance);
  return NitroListEngagedRange{range.start, range.end, range.version};
}

@end
