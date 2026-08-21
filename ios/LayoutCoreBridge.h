#import <Foundation/Foundation.h>

typedef struct {
  int32_t start;
  int32_t end;
  int32_t version;
} NitroListEngagedRange;

NS_ASSUME_NONNULL_BEGIN

@interface NitroListLayoutCore : NSObject

- (BOOL)setItemCount:(int32_t)count;
- (BOOL)setEstimate:(float)value;
- (void)setMeasurementEpsilon:(float)value;
- (void)setDirectionalBuffersEnabled:(BOOL)enabled;
- (void)resetScrollVelocity;
- (BOOL)setEstimatesFrozen:(BOOL)frozen;
- (void)setTypeAveragesEnabled:(BOOL)enabled;
- (void)setItemTypes:(nullable const uint16_t *)types count:(int32_t)count;
- (void)setColumnCount:(int32_t)columns;
- (BOOL)setItemSpans:(nullable const uint16_t *)spans count:(int32_t)count;
- (int32_t)fillLayoutSlab:(double *)out
                 capacity:(int32_t)capacityDoubles
             scrollOffset:(float)scrollOffset
           viewportHeight:(float)viewportHeight
             drawDistance:(float)drawDistance
              outputScale:(float)outputScale;
- (int32_t)fillTypeStats:(double *)out
                capacity:(int32_t)capacityDoubles
             outputScale:(float)outputScale;
- (void)resetAll;
- (NSUInteger)memoryFootprint;
- (BOOL)setItemSize:(int32_t)index size:(float)size;
- (BOOL)setItemSizesBatch:(const double *)pairs pairCount:(int32_t)pairCount;
- (BOOL)seedTypeMeans:(const double *)pairs pairCount:(int32_t)pairCount;
- (float)setItemSizesBatchAnchored:(const double *)pairs
                         pairCount:(int32_t)pairCount
                       anchorIndex:(int32_t)anchorIndex;
- (BOOL)resetItemSizes;
- (BOOL)remapItemSizes:(const double *)pairs pairCount:(int32_t)pairCount;

- (float)totalSize;
- (float)offsetForIndex:(int32_t)index;
- (float)sizeForIndex:(int32_t)index;
- (int32_t)layoutVersion;

- (NitroListEngagedRange)engagedRangeWithScrollOffset:(float)scrollOffset
                                       viewportHeight:(float)viewportHeight
                                         drawDistance:(float)drawDistance;

@end

NS_ASSUME_NONNULL_END
