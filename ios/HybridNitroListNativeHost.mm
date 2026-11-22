#import "HybridNitroListNativeHost.hpp"
#import "EngineRegistry.hpp"
#import "NitroNativeTemplateEngine.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>

#include <atomic>
#include <cmath>
#include <mutex>
#include <unordered_map>

using namespace margelo::nitro;
using namespace margelo::nitro::nitrolist;

static UIView* findReactViewByTag(NSInteger targetTag) {
  if (targetTag <= 0) return nil;
  NSArray<UIWindow*>* windows = nil;
  if (@available(iOS 13.0, *)) {
    NSMutableArray<UIWindow*>* collected = [NSMutableArray array];
    for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
      if ([scene isKindOfClass:[UIWindowScene class]]) {
        UIWindowScene* ws = (UIWindowScene*)scene;
        [collected addObjectsFromArray:ws.windows];
      }
    }
    windows = collected;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    windows = UIApplication.sharedApplication.windows;
#pragma clang diagnostic pop
  }
  for (UIWindow* window in windows) {
    UIView* found = [window viewWithTag:targetTag];
    if (found != nil) return found;
  }
  return nil;
}

static UIScrollView* findScrollViewFromNode(UIView* node) {
  if (node == nil) return nil;
  if ([node isKindOfClass:[UIScrollView class]]) return (UIScrollView*)node;
  for (UIView* sub in node.subviews) {
    if ([sub isKindOfClass:[UIScrollView class]]) return (UIScrollView*)sub;
  }
  return nil;
}

static uint32_t parseGenerationFromView(UIView* view) {
  NSString* ident = nil;
  if ([view respondsToSelector:@selector(nativeId)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id raw = [view performSelector:@selector(nativeId)];
#pragma clang diagnostic pop
    if ([raw isKindOfClass:[NSString class]]) ident = (NSString*)raw;
  }
  if (ident == nil) ident = view.accessibilityIdentifier;
  if (ident == nil || ident.length < 4 || ![ident hasPrefix:@"nl:"]) return 0;
  NSInteger val = [[ident substringFromIndex:3] integerValue];
  return val > 0 ? static_cast<uint32_t>(val) : 0;
}

@interface NLHostSessionObjC : NSObject
@property(nonatomic, assign) int32_t hostId;
@property(nonatomic, assign) int64_t engineId;
@property(nonatomic, assign) NSInteger scrollViewTag;
@property(nonatomic, assign) NSInteger stickyViewTag;
@property(nonatomic, assign) BOOL horizontal;
@property(nonatomic, assign) BOOL userHasOnScroll;
@property(nonatomic, assign) BOOL mvcpEnabled;
@property(nonatomic, assign) BOOL detached;
@property(nonatomic, weak) UIScrollView* scrollView;
@property(nonatomic, weak) UIView* stickyView;
@property(nonatomic, strong) CADisplayLink* displayLink;
@property(nonatomic, strong) NLNativeTemplateEngine* templateEngine;
@property(nonatomic, assign) BOOL templateLoadNotified;
@property(nonatomic, assign) double templateReportedContainerPt;
- (void)applyExternalMvcpShift:(double)deltaPt;
- (void)runTemplateSync;
@end

struct IosSlotRecord {
  NSInteger viewTag = -1;
  uint32_t lastMeasuredGen = 0;
  double lastMeasuredSize = -1.0;
};

@implementation NLHostSessionObjC {
  std::function<void(double, double, double, double, double, double, double,
                     const std::shared_ptr<ArrayBuffer>&)> _onSlotRebinds;
  std::function<void(double, double)> _onContentSize;
  std::unordered_map<int32_t, IosSlotRecord> _slotViews;
  std::unordered_map<int32_t, __weak UIView*> _slotViewCache;
  int32_t _attachRetries;
  BOOL _observingKvo;
  BOOL _inMomentum;
  BOOL _suppressVelocity;
  double _mvcpMomentumShift;
  double _lastOffset;
  CFTimeInterval _lastScrollTime;
  double _lastVelocity;
  double _lastReportedTotal;
  int32_t _lastReportedVersion;
  int32_t _lastStickyIndex;
  std::vector<double> _offsetsBuf;
  std::vector<int32_t> _metaBuf;
}

- (instancetype)initWithId:(int32_t)hostId
                  engineId:(int64_t)engineId
             scrollViewTag:(NSInteger)scrollViewTag
             stickyViewTag:(NSInteger)stickyViewTag
                horizontal:(BOOL)horizontal
           userHasOnScroll:(BOOL)userHasOnScroll
             onSlotRebinds:(std::function<void(double, double, double, double, double, double, double,
                                               const std::shared_ptr<ArrayBuffer>&)>)onSlotRebinds
             onContentSize:(std::function<void(double, double)>)onContentSize {
  if ((self = [super init])) {
    _hostId = hostId;
    _engineId = engineId;
    _scrollViewTag = scrollViewTag;
    _stickyViewTag = stickyViewTag;
    _horizontal = horizontal;
    _userHasOnScroll = userHasOnScroll;
    _onSlotRebinds = std::move(onSlotRebinds);
    _onContentSize = std::move(onContentSize);
    _lastScrollTime = -1.0;
    _lastReportedTotal = -1.0;
    _lastReportedVersion = -1;
    _lastStickyIndex = -1;
    _templateEngine = [[NLNativeTemplateEngine alloc] init];
    _templateLoadNotified = NO;
    _templateReportedContainerPt = 0.0;
    _offsetsBuf.resize(128, 0.0);
    _metaBuf.resize(128 * 3, 0);
  }
  return self;
}

- (void)attachOnMain {
  if (_detached || _observingKvo) return;
  UIView* node = findReactViewByTag(_scrollViewTag);
  UIScrollView* sv = findScrollViewFromNode(node);
  if (sv == nil) {
    if (_attachRetries < 8) {
      _attachRetries++;
      __weak NLHostSessionObjC* weakSelf = self;
      dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf attachOnMain];
      });
    }
    return;
  }
  _scrollView = sv;
  if (!_observingKvo) {
    [sv addObserver:self forKeyPath:@"contentOffset" options:NSKeyValueObservingOptionNew context:nil];
    _observingKvo = YES;
  }
  if (_displayLink == nil) {
    _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(onDisplayLink:)];
    [_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
  }
  double totalSize = 0.0;
  int32_t stickyIndex = -1;
  double stickyTrans = 0.0;
  int32_t existingSlots = 0;
  if (auto state = EngineRegistry::instance().find(_engineId)) {
    existingSlots = state->readSlotTransforms(
        _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
        totalSize, stickyIndex, stickyTrans);
  }
  if (existingSlots <= 0) {
    [self handleScrollOffset:sv.contentOffset];
  }
  [self applyPreDraw];
}

- (void)detachOnMain {
  _detached = YES;
  if (_displayLink != nil) {
    [_displayLink invalidate];
    _displayLink = nil;
  }
  UIScrollView* sv = _scrollView;
  if (_observingKvo && sv != nil) {
    @try {
      [sv removeObserver:self forKeyPath:@"contentOffset"];
    } @catch (__unused NSException* e) {
    }
    _observingKvo = NO;
  }
  _slotViews.clear();
  _slotViewCache.clear();
  [_templateEngine clear];
  _scrollView = nil;
  _stickyView = nil;
}

- (void)registerSlot:(int32_t)slotId tag:(NSInteger)tag {
  if (_detached) return;
  _slotViews[slotId] = IosSlotRecord{tag, 0, -1.0};
  UIView* v = findReactViewByTag(tag);
  if (v != nil) _slotViewCache[slotId] = v;
  [self applyPreDraw];
}

- (void)unregisterSlot:(int32_t)slotId {
  _slotViews.erase(slotId);
  _slotViewCache.erase(slotId);
}

- (void)resetMeasuredHeights {
  for (auto& kv : _slotViews) {
    kv.second.lastMeasuredGen = 0;
    kv.second.lastMeasuredSize = -1.0;
  }
}

- (void)observeValueForKeyPath:(NSString*)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id>*)change
                       context:(void*)context {
  if (_detached) return;
  if ([keyPath isEqualToString:@"contentOffset"] && [object isKindOfClass:[UIScrollView class]]) {
    UIScrollView* sv = (UIScrollView*)object;
    [self handleScrollOffset:sv.contentOffset];
  }
}

- (void)onDisplayLink:(CADisplayLink*)link {
  (void)link;
  if (_detached) return;
  [self applyPreDraw];
}

- (void)handleScrollOffset:(CGPoint)offset {
  auto state = EngineRegistry::instance().find(_engineId);
  if (state == nullptr) return;
  const double offsetPt = _horizontal ? offset.x : offset.y;
  const CFTimeInterval now = CACurrentMediaTime();
  const double stepPt = _lastScrollTime >= 0.0 ? std::abs(offsetPt - _lastOffset) : 0.0;
  UIScrollView* sv = _scrollView;
  const BOOL nowMomentum = sv != nil && sv.isDecelerating;
  const double vpPt = sv != nil ? (_horizontal ? sv.bounds.size.width : sv.bounds.size.height) : 0.0;
  if (!_suppressVelocity) {
    if (!nowMomentum && vpPt > 0.0 && stepPt > vpPt * 1.5) {
      _lastVelocity = 0.0;
    } else if (_lastScrollTime >= 0.0) {
      const double dt = now - _lastScrollTime;
      if (dt > 0.001 && dt <= 0.2) {
        _lastVelocity = (offsetPt - _lastOffset) / dt;
      } else if (dt > 0.2) {
        _lastVelocity = 0.0;
      }
    }
    _lastOffset = offsetPt;
    _lastScrollTime = now;
  }

  if (_inMomentum && !nowMomentum) {
    [self foldMomentumMvcpShift];
    state->onNativeMomentumEnd(_horizontal ? sv.contentOffset.x : sv.contentOffset.y);
  }
  _inMomentum = nowMomentum;

  if (_inMomentum && vpPt > 0.0 && stepPt > vpPt * 2.0) {
    return;
  }

  const double curPt = sv != nil ? (_horizontal ? sv.contentOffset.x : sv.contentOffset.y) : offsetPt;
  const double effectiveOffsetPt = curPt + _mvcpMomentumShift;
  const int32_t budget = std::abs(_lastVelocity) > 25000.0 ? 8 : 0;
  const double jsLatency = _templateEngine.isActive ? -1.0 : 0.0;
  std::vector<SlotDelta> deltas;
  const auto res =
      state->onNativeScroll(effectiveOffsetPt, _lastVelocity, budget, !_inMomentum, deltas, jsLatency);

  [self applyStickyIndex:res.stickyIndex translate:res.stickyTranslateYDp];

  if (_templateEngine.isActive) {
    const BOOL stickyChanged = res.stickyIndex != _lastStickyIndex;
    _lastStickyIndex = res.stickyIndex;
    if (res.deltaCount > 0 || res.changed || !_templateLoadNotified ||
        std::abs(_mvcpMomentumShift) >= 0.25) {
      [self runTemplateSync];
    }
    if (stickyChanged && _onSlotRebinds) {
      auto emptyAb = ArrayBuffer::allocate(4);
      _onSlotRebinds(0.0,
                     static_cast<double>(res.rangeStart),
                     static_cast<double>(res.rangeEnd),
                     static_cast<double>(res.layoutVersion),
                     res.totalSizeDp,
                     static_cast<double>(res.stickyIndex),
                     _lastVelocity,
                     emptyAb);
    }
    return;
  }

  bool needsJsWake = res.stickyIndex != _lastStickyIndex || res.changed;
  if (!needsJsWake && res.deltaCount > 0) {
    for (const auto& d : deltas) {
      if ((d.flags & (SlotDelta::kFlagCreated | SlotDelta::kFlagItemChanged)) != 0) {
        needsJsWake = true;
        break;
      }
    }
  }
  _lastStickyIndex = res.stickyIndex;

  if (needsJsWake && _onSlotRebinds) {
    std::vector<int32_t> packed(std::max<size_t>(1, deltas.size() * 4), 0);
    for (size_t k = 0; k < deltas.size(); ++k) {
      packed[k * 4 + 0] = deltas[k].slotId;
      packed[k * 4 + 1] = deltas[k].itemIndex;
      packed[k * 4 + 2] = static_cast<int32_t>(deltas[k].generation);
      packed[k * 4 + 3] = static_cast<int32_t>(deltas[k].flags);
    }
    auto ab = ArrayBuffer::copy(reinterpret_cast<const uint8_t*>(packed.data()),
                                deltas.size() * 4 * sizeof(int32_t));
    _lastReportedTotal = res.totalSizeDp;
    _lastReportedVersion = res.layoutVersion;
    _onSlotRebinds(static_cast<double>(res.slotCount),
                   static_cast<double>(res.rangeStart),
                   static_cast<double>(res.rangeEnd),
                   static_cast<double>(res.layoutVersion),
                   res.totalSizeDp,
                   static_cast<double>(res.stickyIndex),
                   _lastVelocity,
                   ab);
  }
}

- (void)foldMomentumMvcpShift {
  if (std::abs(_mvcpMomentumShift) < 0.25) {
    _mvcpMomentumShift = 0.0;
    return;
  }
  UIScrollView* sv = _scrollView;
  const double shift = _mvcpMomentumShift;
  _mvcpMomentumShift = 0.0;
  if (sv == nil) return;
  CGPoint pt = sv.contentOffset;
  if (_horizontal) pt.x = std::max(0.0, pt.x + shift);
  else pt.y = std::max(0.0, pt.y + shift);
  _lastOffset = _horizontal ? pt.x : pt.y;
  _suppressVelocity = YES;
  sv.contentOffset = pt;
  _suppressVelocity = NO;
  [_templateEngine invalidateAppliedCoords];
}

- (void)runTemplateSync {
  if (_detached || !_templateEngine.isActive) return;
  auto state = EngineRegistry::instance().find(_engineId);
  UIScrollView* sv = _scrollView;
  if (state == nullptr || sv == nil) return;

  __weak NLHostSessionObjC* weakSelf = self;
  const auto res = [_templateEngine
      syncAndPositionWithEngine:state
                     scrollView:sv
               resolveContainer:^UIView*(NSInteger tag) {
                 return findReactViewByTag(tag);
               }
                     horizontal:_horizontal
                    mvcpEnabled:_mvcpEnabled
                     inMomentum:_inMomentum
            suppressDataRequest:(_inMomentum && std::abs(_lastVelocity) > 18000.0)
              mvcpMomentumShift:_mvcpMomentumShift
               onApplyMvcpDelta:^double(double mvcpDeltaPt) {
                 NLHostSessionObjC* strongSelf = weakSelf;
                 if (strongSelf == nil) return 0.0;
                 if (strongSelf->_inMomentum) {
                   strongSelf->_mvcpMomentumShift += mvcpDeltaPt;
                 } else if (UIScrollView* scrollV = strongSelf->_scrollView) {
                   CGPoint pt = scrollV.contentOffset;
                   if (strongSelf->_horizontal) pt.x = std::max(0.0, pt.x + mvcpDeltaPt);
                   else pt.y = std::max(0.0, pt.y + mvcpDeltaPt);
                   strongSelf->_lastOffset = strongSelf->_horizontal ? pt.x : pt.y;
                   strongSelf->_suppressVelocity = YES;
                   scrollV.contentOffset = pt;
                   strongSelf->_suppressVelocity = NO;
                 }
                 return strongSelf->_mvcpMomentumShift;
               }
             onDrainedMvcpShift:^double(double drainedPt) {
               NLHostSessionObjC* strongSelf = weakSelf;
               if (strongSelf == nil) return 0.0;
               if (std::abs(drainedPt) > 0.1) {
                 strongSelf->_mvcpMomentumShift += drainedPt;
                 UIScrollView* scrollV = strongSelf->_scrollView;
                 if (scrollV != nil && !scrollV.isDecelerating) {
                   [strongSelf foldMomentumMvcpShift];
                 }
               }
               return strongSelf->_mvcpMomentumShift;
             }];

  if (res.slotCount > 0) {
    [self applyStickyIndex:res.stickyIndex translate:res.stickyTranslateDp];
    const double total = res.totalSizeDp;
    const double offsetPt = _horizontal ? sv.contentOffset.x : sv.contentOffset.y;
    const double vpPt = _horizontal ? sv.bounds.size.width : sv.bounds.size.height;
    const BOOL nearEnd =
        vpPt > 0.0 && (offsetPt + vpPt * 3.0) >= std::min(_templateReportedContainerPt, total);
    const BOOL needsReport =
        !_templateLoadNotified || total > _templateReportedContainerPt ||
        (nearEnd && std::abs(total - _templateReportedContainerPt) > 0.5);
    if (needsReport && total > 0.0 && _onContentSize) {
      const double nextReported = (!_templateLoadNotified || nearEnd || _templateReportedContainerPt <= 0.0)
                                      ? total
                                      : total + std::max(vpPt * 2.0, total * 0.1);
      _templateLoadNotified = YES;
      _templateReportedContainerPt = nextReported;
      _lastReportedTotal = nextReported;
      const int32_t ver = res.layoutVersion >= 0 ? res.layoutVersion : _lastReportedVersion + 1;
      _lastReportedVersion = ver;
      _onContentSize(nextReported, static_cast<double>(ver));
    }
  }
}

- (void)applyStickyIndex:(int32_t)stickyIndex translate:(double)translatePt {
  if (_stickyViewTag <= 0) return;
  UIView* sticky = _stickyView;
  if (sticky == nil) {
    sticky = findReactViewByTag(_stickyViewTag);
    _stickyView = sticky;
  }
  if (sticky == nil) return;
  if (stickyIndex < 0) {
    sticky.hidden = YES;
    return;
  }
  sticky.hidden = NO;
  sticky.transform = _horizontal ? CGAffineTransformMakeTranslation(translatePt, 0)
                                 : CGAffineTransformMakeTranslation(0, translatePt);
}

- (void)applyPreDraw {
  if (_templateEngine.isActive) {
    [self runTemplateSync];
    return;
  }
  auto state = EngineRegistry::instance().find(_engineId);
  if (state == nullptr) return;
  const size_t cap = std::max<size_t>(_offsetsBuf.size(), _slotViews.size() + 16);
  if (cap > _offsetsBuf.size()) {
    _offsetsBuf.resize(cap, 0.0);
    _metaBuf.resize(cap * 3, 0);
  }

  double totalSize = 0.0;
  int32_t stickyIndex = -1;
  double stickyTrans = 0.0;
  double pendingMvcp = 0.0;
  int32_t slotCount = state->readSlotTransforms(
      _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
      totalSize, stickyIndex, stickyTrans, &pendingMvcp);
  if (std::abs(pendingMvcp) > 0.1) {
    _mvcpMomentumShift += pendingMvcp;
    UIScrollView* sv = _scrollView;
    if (sv != nil && !sv.isDecelerating) {
      [self foldMomentumMvcpShift];
    }
  }

  std::vector<int32_t> sizeIds;
  std::vector<double> sizeVals;
  std::vector<uint32_t> sizeGens;

  for (int32_t s = 0; s < slotCount; ++s) {
    if (_metaBuf[static_cast<size_t>(s) * 3] == 0) continue;
    auto it = _slotViews.find(s);
    if (it == _slotViews.end()) continue;
    UIView* view = _slotViewCache[s];
    if (view == nil) {
      view = findReactViewByTag(it->second.viewTag);
      if (view != nil) _slotViewCache[s] = view;
    }
    if (view == nil) continue;
    const uint32_t expectedGen = static_cast<uint32_t>(_metaBuf[static_cast<size_t>(s) * 3 + 1]);
    const bool measures = _metaBuf[static_cast<size_t>(s) * 3 + 2] != 0;
    const uint32_t seenGen = parseGenerationFromView(view);
    if (seenGen != expectedGen || !measures) continue;
    const double measured = _horizontal ? view.bounds.size.width : view.bounds.size.height;
    if (measured > 0.0 &&
        (seenGen != it->second.lastMeasuredGen ||
         std::abs(measured - it->second.lastMeasuredSize) > 0.125)) {
      it->second.lastMeasuredGen = seenGen;
      it->second.lastMeasuredSize = measured;
      sizeIds.push_back(s);
      sizeVals.push_back(measured);
      sizeGens.push_back(seenGen);
    }
  }

  if (!sizeIds.empty()) {
    const auto szRes = state->onNativeSlotSizes(
        sizeIds.data(), sizeVals.data(), sizeGens.data(),
        static_cast<int32_t>(sizeIds.size()), _mvcpEnabled);
    if (szRes.changed) {
      if (_mvcpEnabled && std::abs(szRes.mvcpDeltaDp) > 0.1) {
        if (_inMomentum) {
          _mvcpMomentumShift += szRes.mvcpDeltaDp;
        } else if (UIScrollView* sv = _scrollView) {
          CGPoint pt = sv.contentOffset;
          if (_horizontal) pt.x = std::max(0.0, pt.x + szRes.mvcpDeltaDp);
          else pt.y = std::max(0.0, pt.y + szRes.mvcpDeltaDp);
          _lastOffset = _horizontal ? pt.x : pt.y;
          _suppressVelocity = YES;
          sv.contentOffset = pt;
          _suppressVelocity = NO;
        }
      }
      slotCount = state->readSlotTransforms(
          _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
          totalSize, stickyIndex, stickyTrans);
      if (_onContentSize && std::abs(szRes.totalSizeDp - _lastReportedTotal) > 0.5) {
        _lastReportedTotal = szRes.totalSizeDp;
        _lastReportedVersion = szRes.layoutVersion;
        _onContentSize(szRes.totalSizeDp, static_cast<double>(szRes.layoutVersion));
      }
    }
  }

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (int32_t s = 0; s < slotCount; ++s) {
    auto it = _slotViews.find(s);
    if (it == _slotViews.end()) continue;
    UIView* view = _slotViewCache[s];
    if (view == nil) {
      view = findReactViewByTag(it->second.viewTag);
      if (view != nil) _slotViewCache[s] = view;
    }
    if (view == nil) continue;
    const bool active = _metaBuf[static_cast<size_t>(s) * 3] != 0;
    if (!active) {
      view.hidden = YES;
      continue;
    }
    const uint32_t expectedGen = static_cast<uint32_t>(_metaBuf[static_cast<size_t>(s) * 3 + 1]);
    const uint32_t seenGen = parseGenerationFromView(view);
    if (seenGen != expectedGen) {
      view.hidden = YES;
      continue;
    }
    const double target = _offsetsBuf[static_cast<size_t>(s)] - _mvcpMomentumShift;
    const double baseOrigin = _horizontal ? view.center.x - view.bounds.size.width * 0.5
                                          : view.center.y - view.bounds.size.height * 0.5;
    const double rel = target - baseOrigin;
    view.transform = _horizontal ? CGAffineTransformMakeTranslation(rel, 0)
                                 : CGAffineTransformMakeTranslation(0, rel);
    view.hidden = NO;
  }
  [self applyStickyIndex:stickyIndex translate:stickyTrans];
  [CATransaction commit];
}

- (void)applyExternalMvcpShift:(double)deltaPt {
  if (_detached || !std::isfinite(deltaPt) || deltaPt == 0.0) return;
  _mvcpMomentumShift += deltaPt;
  UIScrollView* sv = _scrollView;
  _inMomentum = sv != nil && sv.isDecelerating;
  if (!_inMomentum) {
    [self foldMomentumMvcpShift];
  }
  [self applyPreDraw];
}

@end

namespace {

std::mutex gIosHostsMutex;
std::atomic<int32_t> gNextIosHostId{1};
std::unordered_map<int32_t, NLHostSessionObjC*> gIosHosts;

std::mutex gIosPrefetchMutex;
NSMutableArray<NSURLSessionDataTask*>* gPrefetchTasks = nil;

NLHostSessionObjC* findIosHost(int32_t hostId) {
  std::lock_guard<std::mutex> guard(gIosHostsMutex);
  auto it = gIosHosts.find(hostId);
  return it == gIosHosts.end() ? nil : it->second;
}

} // namespace

namespace margelo::nitro::nitrolist {

HybridNitroListNativeHost::HybridNitroListNativeHost() : HybridObject(TAG) {}

HybridNitroListNativeHost::~HybridNitroListNativeHost() = default;

double HybridNitroListNativeHost::attachHost(
    double engineId,
    double scrollViewTag,
    double stickyViewTag,
    bool horizontal,
    bool userHasOnScroll,
    const std::function<void(double, double, double, double, double, double, double,
                             const std::shared_ptr<ArrayBuffer>&)>& onSlotRebinds,
    const std::function<void(double, double)>& onContentSize) {
  if (!std::isfinite(engineId) || engineId <= 0 || !std::isfinite(scrollViewTag) ||
      scrollViewTag <= 0) {
    return -1.0;
  }
  const int32_t hostId = gNextIosHostId.fetch_add(1, std::memory_order_relaxed);
  NLHostSessionObjC* session = [[NLHostSessionObjC alloc]
         initWithId:hostId
           engineId:static_cast<int64_t>(engineId)
      scrollViewTag:static_cast<NSInteger>(scrollViewTag)
      stickyViewTag:(std::isfinite(stickyViewTag) && stickyViewTag > 0
                         ? static_cast<NSInteger>(stickyViewTag)
                         : -1)
         horizontal:horizontal ? YES : NO
    userHasOnScroll:userHasOnScroll ? YES : NO
      onSlotRebinds:onSlotRebinds
      onContentSize:onContentSize];
  {
    std::lock_guard<std::mutex> guard(gIosHostsMutex);
    gIosHosts[hostId] = session;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [session attachOnMain];
  });
  return static_cast<double>(hostId);
}

void HybridNitroListNativeHost::detachHost(double hostId) {
  if (!std::isfinite(hostId) || hostId <= 0) return;
  NLHostSessionObjC* session = nil;
  {
    std::lock_guard<std::mutex> guard(gIosHostsMutex);
    auto it = gIosHosts.find(static_cast<int32_t>(hostId));
    if (it != gIosHosts.end()) {
      session = it->second;
      gIosHosts.erase(it);
    }
  }
  if (session != nil) {
    session.detached = YES;
    dispatch_async(dispatch_get_main_queue(), ^{
      [session detachOnMain];
    });
  }
}

void HybridNitroListNativeHost::registerSlotView(double hostId, double slotId, double viewTag,
                                                 bool measures) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil || slotId < 0 || viewTag <= 0) return;
  auto state = EngineRegistry::instance().find(session.engineId);
  if (state != nullptr) {
    state->setSlotViewTag(static_cast<int32_t>(slotId), static_cast<int32_t>(viewTag), measures);
  }
  const int32_t sid = static_cast<int32_t>(slotId);
  const NSInteger vtag = static_cast<NSInteger>(viewTag);
  dispatch_async(dispatch_get_main_queue(), ^{
    [session registerSlot:sid tag:vtag];
  });
}

void HybridNitroListNativeHost::unregisterSlotView(double hostId, double slotId) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil || slotId < 0) return;
  auto state = EngineRegistry::instance().find(session.engineId);
  if (state != nullptr) {
    state->unregisterSlotView(static_cast<int32_t>(slotId));
  }
  const int32_t sid = static_cast<int32_t>(slotId);
  dispatch_async(dispatch_get_main_queue(), ^{
    [session unregisterSlot:sid];
  });
}

void HybridNitroListNativeHost::setSlotMeasures(double hostId, double slotId, bool measures) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil || slotId < 0) return;
  auto state = EngineRegistry::instance().find(session.engineId);
  if (state != nullptr) {
    state->setSlotMeasures(static_cast<int32_t>(slotId), measures);
  }
}

void HybridNitroListNativeHost::setStickyViewTag(double hostId, double stickyViewTag) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  const NSInteger tag =
      (std::isfinite(stickyViewTag) && stickyViewTag > 0) ? static_cast<NSInteger>(stickyViewTag) : -1;
  dispatch_async(dispatch_get_main_queue(), ^{
    session.stickyViewTag = tag;
    session.stickyView = nil;
  });
}

void HybridNitroListNativeHost::setUserHasOnScroll(double hostId, bool hasOnScroll) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  session.userHasOnScroll = hasOnScroll ? YES : NO;
}

void HybridNitroListNativeHost::setMvcpEnabled(double hostId, bool enabled) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  session.mvcpEnabled = enabled ? YES : NO;
  auto state = EngineRegistry::instance().find(session.engineId);
  if (state != nullptr) {
    state->setMvcpEnabled(enabled);
  }
}

void HybridNitroListNativeHost::applyMvcpShift(double hostId, double deltaDp) {
  if (!std::isfinite(deltaDp) || deltaDp == 0.0) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [session applyExternalMvcpShift:deltaDp];
  });
}

void HybridNitroListNativeHost::notifyDataCommit(double hostId, double paddingStartDp,
                                                 double mainAxisGapDp) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  auto state = EngineRegistry::instance().find(session.engineId);
  if (state != nullptr) {
    state->updateHostGeometry(paddingStartDp, mainAxisGapDp);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session resetMeasuredHeights];
    if (UIScrollView* sv = session.scrollView) {
      [session handleScrollOffset:sv.contentOffset];
    }
    [session applyPreDraw];
  });
}

void HybridNitroListNativeHost::syncNow(double hostId) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    auto state = EngineRegistry::instance().find(session.engineId);
    const bool prewarmActive = (state != nullptr && state->isJsPrewarmActive());
    if (!prewarmActive) {
      if (UIScrollView* sv = session.scrollView) {
        [session handleScrollOffset:sv.contentOffset];
      }
    }
    [session applyPreDraw];
  });
}

void HybridNitroListNativeHost::prefetchImages(const std::vector<std::string>& uris,
                                               double /* widthPx */, double /* heightPx */) {
  if (uris.empty()) return;
  std::lock_guard<std::mutex> guard(gIosPrefetchMutex);
  if (gPrefetchTasks == nil) gPrefetchTasks = [NSMutableArray array];
  NSURLSession* session = [NSURLSession sharedSession];
  for (const auto& raw : uris) {
    if (raw.empty()) continue;
    NSString* str = [NSString stringWithUTF8String:raw.c_str()];
    NSURL* url = [NSURL URLWithString:str];
    if (url == nil) continue;
    NSMutableURLRequest* req =
        [NSMutableURLRequest requestWithURL:url
                                cachePolicy:NSURLRequestReturnCacheDataElseLoad
                            timeoutInterval:15.0];
    NSURLSessionDataTask* task = [session dataTaskWithRequest:req
                                            completionHandler:^(__unused NSData* data,
                                                                __unused NSURLResponse* response,
                                                                __unused NSError* error) {}];
    if (gPrefetchTasks.count >= 24) {
      NSURLSessionDataTask* oldest = gPrefetchTasks.firstObject;
      [oldest cancel];
      [gPrefetchTasks removeObjectAtIndex:0];
    }
    [gPrefetchTasks addObject:task];
    [task resume];
  }
}

void HybridNitroListNativeHost::cancelImagePrefetch() {
  std::lock_guard<std::mutex> guard(gIosPrefetchMutex);
  if (gPrefetchTasks == nil) return;
  for (NSURLSessionDataTask* task in gPrefetchTasks) {
    [task cancel];
  }
  [gPrefetchTasks removeAllObjects];
}

void HybridNitroListNativeHost::attachNativeSlotContainer(double hostId,
                                                          double containerViewTag,
                                                          double numColumns,
                                                          double crossAxisGapDp) {
  if (!std::isfinite(hostId) || hostId <= 0 || !std::isfinite(containerViewTag) ||
      containerViewTag <= 0) {
    return;
  }
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  const NSInteger tag = static_cast<NSInteger>(containerViewTag);
  const int32_t cols =
      (std::isfinite(numColumns) && numColumns >= 1.0) ? static_cast<int32_t>(numColumns) : 1;
  const double gap = (std::isfinite(crossAxisGapDp) && crossAxisGapDp >= 0.0) ? crossAxisGapDp : 0.0;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    UIView* resolved = findReactViewByTag(tag);
    [session.templateEngine setContainerTag:tag numColumns:cols crossAxisGapPt:gap resolved:resolved];
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      if (state == nullptr || !state->isJsPrewarmActive()) {
        [session handleScrollOffset:sv.contentOffset];
      }
      [session runTemplateSync];
    }
  });
}

void HybridNitroListNativeHost::setNativeTemplateSchema(double hostId,
                                                        const std::string& schemaJson) {
  if (!std::isfinite(hostId) || hostId <= 0 || schemaJson.empty()) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  NSString* json = [NSString stringWithUTF8String:schemaJson.c_str()];
  if (json == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine setSchemaJson:json];
    session.templateLoadNotified = NO;
    session.templateReportedContainerPt = 0.0;
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      if (state == nullptr || !state->isJsPrewarmActive()) {
        [session handleScrollOffset:sv.contentOffset];
      }
      [session runTemplateSync];
    }
  });
}

void HybridNitroListNativeHost::setNativeTemplateData(
    double hostId, double startIndex, double count, double totalCount, bool reset,
    const std::shared_ptr<ArrayBuffer>& packedData) {
  if (!std::isfinite(hostId) || hostId <= 0 || !std::isfinite(startIndex) ||
      !std::isfinite(count) || !std::isfinite(totalCount) || packedData == nullptr) {
    return;
  }
  const int32_t s = static_cast<int32_t>(startIndex);
  const int32_t c = static_cast<int32_t>(count);
  const int32_t t = static_cast<int32_t>(totalCount);
  const size_t len = packedData->size();
  if (s < 0 || c <= 0 || t <= 0 || len < 16) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  // Copy bytes synchronously on JSI thread before hopping to main queue
  NSData* copy = [NSData dataWithBytes:packedData->data() length:len];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine setDataChunkStart:s
                                        count:c
                                   totalCount:t
                                        reset:reset ? YES : NO
                                        bytes:static_cast<const uint8_t*>(copy.bytes)
                                       length:copy.length];
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      if (state == nullptr || !state->isJsPrewarmActive()) {
        [session handleScrollOffset:sv.contentOffset];
      }
      [session runTemplateSync];
    }
  });
}

void HybridNitroListNativeHost::shiftNativeTemplateData(double hostId, double delta,
                                                        double totalCount) {
  if (!std::isfinite(hostId) || hostId <= 0 || !std::isfinite(delta) || !std::isfinite(totalCount)) {
    return;
  }
  const int32_t d = static_cast<int32_t>(delta);
  const int32_t t = static_cast<int32_t>(totalCount);
  if (d == 0 || t < 0) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine shiftDataIndicesDelta:d totalCount:t];
  });
}

void HybridNitroListNativeHost::setNativePressHandler(
    double hostId, const std::function<void(double, const std::string&)>& onPress) {
  if (!std::isfinite(hostId) || hostId <= 0) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  auto cb = onPress;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine setPressHandler:std::move(cb)];
  });
}

void HybridNitroListNativeHost::setNativeDataRequestHandler(
    double hostId, const std::function<void(double, double)>& onRequestData) {
  if (!std::isfinite(hostId) || hostId <= 0) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  auto cb = onRequestData;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine setDataRequestHandler:std::move(cb)];
  });
}

void HybridNitroListNativeHost::clearNativeTemplate(double hostId) {
  if (!std::isfinite(hostId) || hostId <= 0) return;
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (session.detached) return;
    [session.templateEngine clear];
    session.templateLoadNotified = NO;
    session.templateReportedContainerPt = 0.0;
  });
}

} // namespace margelo::nitro::nitrolist
