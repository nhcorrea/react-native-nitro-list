#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#include "EngineRegistry.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

struct NLTemplateSyncResult {
  int32_t slotCount = 0;
  bool layoutChanged = false;
  double totalSizeDp = 0.0;
  int32_t layoutVersion = -1;
  int32_t stickyIndex = -1;
  double stickyTranslateDp = 0.0;
};

@interface NLNativeTemplateEngine : NSObject

@property(nonatomic, readonly) BOOL isActive;

- (void)setContainerTag:(NSInteger)tag
             numColumns:(int32_t)numColumns
         crossAxisGapPt:(double)crossAxisGapPt
               resolved:(nullable UIView*)resolved;

- (void)setSchemaJson:(nonnull NSString*)schemaJson;

- (void)setDataChunkStart:(int32_t)startIndex
                    count:(int32_t)count
               totalCount:(int32_t)totalCount
                    reset:(BOOL)reset
                    bytes:(nonnull const uint8_t*)bytes
                   length:(size_t)length;

- (void)shiftDataIndicesDelta:(int32_t)delta totalCount:(int32_t)totalCount;

- (void)setPressHandler:(std::function<void(double, const std::string&)>)handler;
- (void)setDataRequestHandler:(std::function<void(double, double)>)handler;
- (void)clear;
- (void)invalidateAppliedCoords;

- (NLTemplateSyncResult)
    syncAndPositionWithEngine:(const std::shared_ptr<margelo::nitro::nitrolist::EngineCoreState>&)state
                   scrollView:(nonnull UIScrollView*)sv
             resolveContainer:(UIView* _Nullable (^_Nonnull)(NSInteger))resolveContainer
                   horizontal:(BOOL)horizontal
                  mvcpEnabled:(BOOL)mvcpEnabled
                   inMomentum:(BOOL)inMomentum
          suppressDataRequest:(BOOL)suppressDataRequest
            mvcpMomentumShift:(double)mvcpMomentumShift
             onApplyMvcpDelta:(double (^_Nonnull)(double))onApplyMvcpDelta
           onDrainedMvcpShift:(double (^_Nonnull)(double))onDrainedMvcpShift;

@end
