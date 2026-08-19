#import <Foundation/Foundation.h>

/// Mirrors `LayoutCore::EngagedRange`. `end == -1` means "no engaged items".
typedef struct {
  int32_t start;
  int32_t end;
  int32_t version;
} NitroListEngagedRange;

NS_ASSUME_NONNULL_BEGIN

/// Objective-C++ bridge over the shared C++ `LayoutCore` (cpp/LayoutCore.cpp),
/// the single layout engine used by both platforms. Pure forwarding — all
/// math, caching and locking live in C++. Units are points (the core is
/// unit-agnostic; iOS passes points, Android passes pixels).
@interface NitroListLayoutCore : NSObject

/// Returns YES if the count actually changed.
- (BOOL)setItemCount:(int32_t)count;
/// Replaces the size of every unmeasured item. Returns YES if any changed.
- (BOOL)setEstimate:(float)value;
/// Deltas ≤ epsilon are measurement noise, not size changes (≈1 physical px).
- (void)setMeasurementEpsilon:(float)value;
/// Redistributes drawDistance by scroll direction (1.5× ahead / 0.5× behind).
- (void)setDirectionalBuffersEnabled:(BOOL)enabled;
/// Per-type running means replace the global estimate for unmeasured items.
- (void)setTypeAveragesEnabled:(BOOL)enabled;
/// One uint16 type id per index (0 = untyped). NULL/short input → untyped.
- (void)setItemTypes:(nullable const uint16_t *)types count:(int32_t)count;
/// Fills `out` with [version, total, start, end, (offset, size)…] × scale.
/// Returns items written, or -1 when `capacityDoubles` is too small.
- (int32_t)fillLayoutSlab:(double *)out
                 capacity:(int32_t)capacityDoubles
             scrollOffset:(float)scrollOffset
           viewportHeight:(float)viewportHeight
             drawDistance:(float)drawDistance
              outputScale:(float)outputScale;
/// Full reset for Fabric view recycling; wrapper-set config survives.
- (void)resetAll;
/// Bytes of heap storage owned by the item arrays (capacity-based).
- (NSUInteger)memoryFootprint;
/// Returns YES if the stored size actually changed.
- (BOOL)setItemSize:(int32_t)index size:(float)size;
/// `pairs` = `pairCount` × [index, size] doubles (a JS Float64Array).
- (BOOL)setItemSizesBatch:(const double *)pairs pairCount:(int32_t)pairCount;
/// Seeds per-type means from JS's cross-mount cache; `pairs` = `pairCount` ×
/// [typeId, mean] doubles. Seeds never beat real samples nor mark measured.
- (BOOL)seedTypeMeans:(const double *)pairs pairCount:(int32_t)pairCount;
/// MVCP variant: applies the batch and returns the anchor's offset delta,
/// computed under the same lock acquisition as the mutation.
- (float)setItemSizesBatchAnchored:(const double *)pairs
                         pairCount:(int32_t)pairCount
                       anchorIndex:(int32_t)anchorIndex;
/// Reverts every item to the estimate (structural data change).
- (BOOL)resetItemSizes;

- (float)totalSize;
- (float)offsetForIndex:(int32_t)index;
- (float)sizeForIndex:(int32_t)index;
- (int32_t)layoutVersion;

- (NitroListEngagedRange)engagedRangeWithScrollOffset:(float)scrollOffset
                                       viewportHeight:(float)viewportHeight
                                         drawDistance:(float)drawDistance;

@end

NS_ASSUME_NONNULL_END
