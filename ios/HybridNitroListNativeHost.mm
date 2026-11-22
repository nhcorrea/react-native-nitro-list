#import "HybridNitroListNativeHost.hpp"
#import "EngineRegistry.hpp"
#import "NitroNativeTemplateEngine.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <unordered_map>
#include <vector>

using namespace margelo::nitro;
using namespace margelo::nitro::nitrolist;

static constexpr int32_t kMaxAttachFrameRetries = 180;
static constexpr double kFlingPacingVelocityPtS = 25000.0;
static constexpr double kSupersonicStepViewports = 2.0;

static UIView* findReactViewByTag(NSInteger targetTag) {
  if (targetTag <= 0) return nil;
  NSMutableArray<UIWindow*>* windows = [NSMutableArray array];
  if (@available(iOS 13.0, *)) {
    for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) continue;
      UIWindowScene* ws = (UIWindowScene*)scene;
      for (UIWindow* w in ws.windows) {
        if (w.isKeyWindow) {
          [windows insertObject:w atIndex:0];
        } else {
          [windows addObject:w];
        }
      }
    }
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [windows addObjectsFromArray:UIApplication.sharedApplication.windows];
#pragma clang diagnostic pop
  }
  for (UIWindow* window in windows) {
    UIView* found = [window viewWithTag:targetTag];
    if (found != nil && found != window) return found;
  }
  return nil;
}

static UIScrollView* scrollViewPropertyOf(UIView* node) {
  if (node == nil) return nil;
  if ([node isKindOfClass:[UIScrollView class]]) return (UIScrollView*)node;
  if ([node respondsToSelector:@selector(scrollView)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id raw = [node performSelector:@selector(scrollView)];
#pragma clang diagnostic pop
    if ([raw isKindOfClass:[UIScrollView class]]) return (UIScrollView*)raw;
  }
  return nil;
}

static BOOL findScrollHostAndView(UIView* root,
                                  UIScrollView* __autoreleasing* outScrollView,
                                  UIView* __autoreleasing* outScrollHost) {
  if (root == nil) return NO;
  if ([root isKindOfClass:[UIScrollView class]]) {
    *outScrollView = (UIScrollView*)root;
    UIView* parent = root.superview;
    *outScrollHost =
        (parent != nil && [parent respondsToSelector:@selector(addScrollListener:)]) ? parent : nil;
    return YES;
  }
  if (UIScrollView* direct = scrollViewPropertyOf(root)) {
    *outScrollView = direct;
    *outScrollHost = [root respondsToSelector:@selector(addScrollListener:)] ? root : nil;
    return YES;
  }
  // BFS through descendants so custom renderScrollComponent wrappers work seamlessly.
  NSMutableArray<UIView*>* queue = [NSMutableArray arrayWithArray:root.subviews];
  NSUInteger head = 0;
  while (head < queue.count) {
    UIView* cur = queue[head++];
    if ([cur isKindOfClass:[UIScrollView class]]) {
      *outScrollView = (UIScrollView*)cur;
      UIView* parent = cur.superview;
      *outScrollHost =
          (parent != nil && [parent respondsToSelector:@selector(addScrollListener:)]) ? parent
                                                                                       : nil;
      return YES;
    }
    if (UIScrollView* nested = scrollViewPropertyOf(cur)) {
      *outScrollView = nested;
      *outScrollHost = [cur respondsToSelector:@selector(addScrollListener:)] ? cur : nil;
      return YES;
    }
    NSArray<UIView*>* subs = cur.subviews;
    if (subs.count > 0 && queue.count < 256) {
      [queue addObjectsFromArray:subs];
    }
  }
  return NO;
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

static inline double viewBaseOrigin(UIView* view, BOOL horizontal) {
  CALayer* layer = view.layer;
  if (horizontal) {
    return layer.position.x - layer.bounds.size.width * layer.anchorPoint.x;
  }
  return layer.position.y - layer.bounds.size.height * layer.anchorPoint.y;
}

// Mark @"transform" as natively managed on RCTViewComponentView so Fabric's
// -[RCTViewComponentView prepareForRecycle] synchronously resets layer.transform
// to identity before returning the view to RCTComponentViewRegistry's recycle pool.
// Without this, recycled <View> instances across the entire app inherit stale
// translateY(+10000+) transforms and render offscreen / blank!
static void markTransformManagedByNative(UIView* view) {
  if (view == nil) return;
  SEL getter = @selector(propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN);
  SEL setter = @selector(setPropKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN:);
  if (![view respondsToSelector:getter] || ![view respondsToSelector:setter]) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
  NSSet<NSString*>* existing = [view performSelector:getter];
  if (existing != nil && [existing containsObject:@"transform"]) return;
  NSSet<NSString*>* updated = existing != nil ? [existing setByAddingObject:@"transform"]
                                              : [NSSet setWithObject:@"transform"];
  [view performSelector:setter withObject:updated];
#pragma clang diagnostic pop
}

static void resetNativeManagedView(UIView* view, NSInteger expectedTag) {
  if (view == nil || expectedTag <= 0 || view.tag != expectedTag) return;
  if (!CGAffineTransformIsIdentity(view.transform)) {
    view.transform = CGAffineTransformIdentity;
  }
  if (view.hidden) {
    view.hidden = NO;
  }
}

@class NLHostSessionObjC;

@interface NLDisplayLinkProxy : NSObject
@property(nonatomic, weak) NLHostSessionObjC* target;
- (void)tick:(CADisplayLink*)link;
@end

@interface NLScrollObserverProxy : NSObject <UIScrollViewDelegate>
@property(nonatomic, weak) NLHostSessionObjC* target;
@end

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
@property(nonatomic, weak) UIView* scrollHost;
@property(nonatomic, weak) UIView* stickyView;
@property(nonatomic, strong) CADisplayLink* displayLink;
@property(nonatomic, strong) NLDisplayLinkProxy* displayLinkProxy;
@property(nonatomic, strong) NLScrollObserverProxy* scrollProxy;
@property(nonatomic, strong) NLNativeTemplateEngine* templateEngine;
@property(nonatomic, assign) BOOL templateLoadNotified;
@property(nonatomic, assign) double templateReportedContainerPt;
- (BOOL)ensureAttachedOnMain;
- (void)detachOnMain;
- (void)registerSlot:(int32_t)slotId tag:(NSInteger)tag;
- (void)unregisterSlot:(int32_t)slotId;
- (void)resetMeasuredHeights;
- (void)markDirtyAndSyncNow;
- (void)markStickyUpdated;
- (void)applyExternalMvcpShift:(double)deltaPt;
- (void)handleScrollOffset:(CGPoint)offset force:(BOOL)force;
- (void)applyPreDraw;
- (void)runTemplateSync;
- (void)onDisplayLink:(CADisplayLink*)link;
- (void)onScrollViewDidScroll:(UIScrollView*)sv;
- (void)onScrollViewWillBeginDragging:(UIScrollView*)sv;
- (void)onScrollViewDidEndDragging:(UIScrollView*)sv willDecelerate:(BOOL)decelerate;
- (void)onScrollViewWillBeginDecelerating:(UIScrollView*)sv;
- (void)onScrollViewDidEndDecelerating:(UIScrollView*)sv;
- (void)onScrollViewDidEndScrollingAnimation:(UIScrollView*)sv;
- (void)onScrollViewDidScrollToTop:(UIScrollView*)sv;
@end

@implementation NLDisplayLinkProxy
- (void)tick:(CADisplayLink*)link {
  NLHostSessionObjC* t = _target;
  if (t == nil) {
    [link invalidate];
    return;
  }
  [t onDisplayLink:link];
}
@end

@implementation NLScrollObserverProxy
- (void)scrollViewDidScroll:(UIScrollView*)scrollView {
  [_target onScrollViewDidScroll:scrollView];
}
- (void)scrollViewWillBeginDragging:(UIScrollView*)scrollView {
  [_target onScrollViewWillBeginDragging:scrollView];
}
- (void)scrollViewDidEndDragging:(UIScrollView*)scrollView willDecelerate:(BOOL)decelerate {
  [_target onScrollViewDidEndDragging:scrollView willDecelerate:decelerate];
}
- (void)scrollViewWillBeginDecelerating:(UIScrollView*)scrollView {
  [_target onScrollViewWillBeginDecelerating:scrollView];
}
- (void)scrollViewDidEndDecelerating:(UIScrollView*)scrollView {
  [_target onScrollViewDidEndDecelerating:scrollView];
}
- (void)scrollViewDidEndScrollingAnimation:(UIScrollView*)scrollView {
  [_target onScrollViewDidEndScrollingAnimation:scrollView];
}
- (void)scrollViewDidScrollToTop:(UIScrollView*)scrollView {
  [_target onScrollViewDidScrollToTop:scrollView];
}
@end

struct IosSlotRecord {
  NSInteger viewTag = -1;
  uint32_t lastMeasuredGen = 0;
  double lastMeasuredSize = -1.0;
  uint32_t appliedGen = 0;
  double appliedTargetPt = NAN;
  double appliedBaseOrigin = NAN;
  int8_t appliedVisible = -1;  // -1 unknown, 0 hidden, 1 visible
  uint8_t zeroMeasureFrames = 0;
};

@implementation NLHostSessionObjC {
  std::function<void(double, double, double, double, double, double, double,
                     const std::shared_ptr<ArrayBuffer>&)> _onSlotRebinds;
  std::function<void(double, double)> _onContentSize;
  std::unordered_map<int32_t, IosSlotRecord> _slotViews;
  std::unordered_map<int32_t, __weak UIView*> _slotViewCache;
  // Strong ref held ONLY during KVO fallback so dealloc can never fire KVO-still-registered crash.
  UIScrollView* _kvoObservedScrollView;
  __weak id _attachedSplitter;
  int32_t _attachFrameRetries;
  BOOL _needsAttach;
  BOOL _attachedViaHostListener;
  BOOL _attachedViaSplitter;
  BOOL _observingKvo;
  BOOL _inMomentum;
  BOOL _inPreDraw;
  BOOL _preDrawDirty;
  BOOL _transformsDirty;
  BOOL _needsPacing;
  BOOL _suppressVelocity;
  int32_t _pendingAwaitingGenCount;
  double _mvcpMomentumShift;
  double _lastOffset;
  double _lastHandledOffset;
  CFTimeInterval _lastScrollTime;
  double _lastVelocity;
  CFTimeInterval _jsWakeSentTime;
  double _jsLatencyMs;
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
    _needsAttach = YES;
    _preDrawDirty = YES;
    _transformsDirty = YES;
    _lastHandledOffset = NAN;
    _lastScrollTime = -1.0;
    _jsWakeSentTime = 0.0;
    _jsLatencyMs = 8.0;
    _lastReportedTotal = -1.0;
    _lastReportedVersion = -1;
    _lastStickyIndex = -1;
    _scrollProxy = [[NLScrollObserverProxy alloc] init];
    _scrollProxy.target = self;
    _templateEngine = [[NLNativeTemplateEngine alloc] init];
    _templateLoadNotified = NO;
    _templateReportedContainerPt = 0.0;
    _offsetsBuf.resize(128, 0.0);
    _metaBuf.resize(128 * 3, 0);
  }
  return self;
}

- (void)ensureBufferCapacity:(size_t)needed {
  if (needed <= _offsetsBuf.size()) return;
  size_t next = std::max<size_t>(_offsetsBuf.size(), 128);
  while (next < needed) next *= 2;
  _offsetsBuf.resize(next, 0.0);
  _metaBuf.resize(next * 3, 0);
}

- (void)ensureDisplayLinkCreated {
  if (_detached || _displayLink != nil) return;
  _displayLinkProxy = [[NLDisplayLinkProxy alloc] init];
  _displayLinkProxy.target = self;
  _displayLink = [CADisplayLink displayLinkWithTarget:_displayLinkProxy selector:@selector(tick:)];
  [_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)updateDisplayLinkState {
  if (_detached) {
    if (_displayLink != nil) {
      [_displayLink invalidate];
      _displayLink = nil;
    }
    return;
  }
  const BOOL wantsTicks = _needsAttach || _needsPacing || _preDrawDirty ||
                          _pendingAwaitingGenCount > 0 || std::abs(_mvcpMomentumShift) >= 0.25;
  if (wantsTicks) {
    [self ensureDisplayLinkCreated];
    if (_displayLink != nil && _displayLink.isPaused) {
      _displayLink.paused = NO;
    }
  } else if (_displayLink != nil && !_displayLink.isPaused) {
    _displayLink.paused = YES;
  }
}

- (void)detachScrollObservation {
  if (_attachedViaHostListener) {
    UIView* host = _scrollHost;
    if (host != nil && [host respondsToSelector:@selector(removeScrollListener:)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      [host performSelector:@selector(removeScrollListener:) withObject:_scrollProxy];
#pragma clang diagnostic pop
    }
    _attachedViaHostListener = NO;
  }
  if (_attachedViaSplitter) {
    id splitter = _attachedSplitter;
    if (splitter != nil && [splitter respondsToSelector:@selector(removeDelegate:)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      [splitter performSelector:@selector(removeDelegate:) withObject:_scrollProxy];
#pragma clang diagnostic pop
    }
    _attachedSplitter = nil;
    _attachedViaSplitter = NO;
  }
  if (_observingKvo) {
    UIScrollView* sv = _kvoObservedScrollView;
    if (sv != nil) {
      @try {
        [sv removeObserver:self forKeyPath:@"contentOffset"];
      } @catch (__unused NSException* e) {
      }
    }
    _kvoObservedScrollView = nil;
    _observingKvo = NO;
  }
  _scrollView = nil;
  _scrollHost = nil;
}

- (BOOL)ensureAttachedOnMain {
  if (_detached) return NO;
  UIScrollView* existingSv = _scrollView;
  const BOOL hasObserver = _attachedViaHostListener || _attachedViaSplitter || _observingKvo;
  if (existingSv != nil && existingSv.window != nil && hasObserver) {
    _needsAttach = NO;
    return YES;
  }
  if (existingSv != nil || hasObserver) {
    [self detachScrollObservation];
  }

  UIView* node = findReactViewByTag(_scrollViewTag);
  UIScrollView* sv = nil;
  UIView* host = nil;
  if (!findScrollHostAndView(node, &sv, &host) || sv == nil || sv.window == nil) {
    _needsAttach = YES;
    [self updateDisplayLinkState];
    return NO;
  }

  _scrollView = sv;
  _scrollHost = host;
  _needsAttach = NO;
  _attachFrameRetries = 0;

  if (host != nil && [host respondsToSelector:@selector(addScrollListener:)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    [host performSelector:@selector(addScrollListener:) withObject:_scrollProxy];
#pragma clang diagnostic pop
    _attachedViaHostListener = YES;
  } else if ([sv respondsToSelector:@selector(delegateSplitter)]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id splitter = [sv performSelector:@selector(delegateSplitter)];
    if (splitter != nil && [splitter respondsToSelector:@selector(addDelegate:)]) {
      [splitter performSelector:@selector(addDelegate:) withObject:_scrollProxy];
      _attachedSplitter = splitter;
      _attachedViaSplitter = YES;
    }
#pragma clang diagnostic pop
  }
  if (!_attachedViaHostListener && !_attachedViaSplitter) {
    [sv addObserver:self forKeyPath:@"contentOffset" options:NSKeyValueObservingOptionNew context:nil];
    _kvoObservedScrollView = sv;
    _observingKvo = YES;
  }

  _lastHandledOffset = NAN;
  _preDrawDirty = YES;
  _transformsDirty = YES;

  double totalSize = 0.0;
  int32_t stickyIndex = -1;
  double stickyTrans = 0.0;
  int32_t existingSlots = 0;
  const double curPt = _horizontal ? sv.contentOffset.x : sv.contentOffset.y;
  bool prewarmBlocking = false;
  if (auto state = EngineRegistry::instance().find(_engineId)) {
    existingSlots = state->readSlotTransforms(
        _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
        totalSize, stickyIndex, stickyTrans);
    prewarmBlocking = state->isJsPrewarmActiveAtOffset(curPt);
  }
  if ((existingSlots <= 0 || _templateEngine.isActive || std::abs(curPt) > 1.0) && !prewarmBlocking) {
    [self handleScrollOffset:sv.contentOffset force:YES];
  }
  [self applyPreDraw];
  [self updateDisplayLinkState];
  return YES;
}

- (void)detachOnMain {
  _detached = YES;
  _needsAttach = NO;
  _needsPacing = NO;
  if (_displayLink != nil) {
    [_displayLink invalidate];
    _displayLink = nil;
  }
  _displayLinkProxy = nil;
  [self detachScrollObservation];
  _scrollProxy.target = nil;
  _scrollProxy = nil;
  for (const auto& kv : _slotViews) {
    auto cacheIt = _slotViewCache.find(kv.first);
    UIView* view = cacheIt != _slotViewCache.end() ? cacheIt->second : nil;
    resetNativeManagedView(view, kv.second.viewTag);
  }
  _slotViews.clear();
  _slotViewCache.clear();
  [_templateEngine clear];
  resetNativeManagedView(_stickyView, _stickyViewTag);
  _stickyView = nil;
}

- (void)registerSlot:(int32_t)slotId tag:(NSInteger)tag {
  if (_detached) return;
  _slotViews[slotId] = IosSlotRecord{tag, 0, -1.0, 0, NAN, NAN, -1, 0};
  UIView* v = findReactViewByTag(tag);
  if (v != nil) {
    markTransformManagedByNative(v);
    _slotViewCache[slotId] = v;
  }
  _preDrawDirty = YES;
  _transformsDirty = YES;
  if (_scrollView == nil || _scrollView.window == nil) {
    _attachFrameRetries = 0;
    [self ensureAttachedOnMain];
  }
  [self applyPreDraw];
  [self updateDisplayLinkState];
}

- (void)unregisterSlot:(int32_t)slotId {
  auto recIt = _slotViews.find(slotId);
  auto cacheIt = _slotViewCache.find(slotId);
  if (recIt != _slotViews.end() && cacheIt != _slotViewCache.end()) {
    resetNativeManagedView(cacheIt->second, recIt->second.viewTag);
  }
  _slotViews.erase(slotId);
  _slotViewCache.erase(slotId);
}

- (void)resetMeasuredHeights {
  for (auto& kv : _slotViews) {
    kv.second.lastMeasuredGen = 0;
    kv.second.lastMeasuredSize = -1.0;
    kv.second.appliedGen = 0;
    kv.second.appliedTargetPt = NAN;
    kv.second.appliedBaseOrigin = NAN;
    kv.second.zeroMeasureFrames = 0;
  }
  _preDrawDirty = YES;
  _transformsDirty = YES;
}

- (void)markStickyUpdated {
  if (_detached) return;
  _preDrawDirty = YES;
  _transformsDirty = YES;
  [self applyPreDraw];
  [self updateDisplayLinkState];
}

- (void)markDirtyAndSyncNow {
  if (_detached) return;
  _preDrawDirty = YES;
  _transformsDirty = YES;
  if (_scrollView == nil || _scrollView.window == nil) {
    _attachFrameRetries = 0;
    [self ensureAttachedOnMain];
  }
  if (UIScrollView* sv = _scrollView) {
    auto state = EngineRegistry::instance().find(_engineId);
    const double curPt = _horizontal ? sv.contentOffset.x : sv.contentOffset.y;
    const bool prewarmActive = (state != nullptr && state->isJsPrewarmActiveAtOffset(curPt));
    if (!prewarmActive) {
      [self handleScrollOffset:sv.contentOffset force:YES];
    }
  }
  [self applyPreDraw];
  [self updateDisplayLinkState];
}

- (void)observeValueForKeyPath:(NSString*)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id>*)change
                       context:(void*)context {
  (void)change;
  (void)context;
  if (_detached || !_observingKvo) return;
  if ([keyPath isEqualToString:@"contentOffset"] && [object isKindOfClass:[UIScrollView class]]) {
    UIScrollView* sv = (UIScrollView*)object;
    [self onScrollViewDidScroll:sv];
  }
}

- (void)onScrollViewDidScroll:(UIScrollView*)sv {
  if (_detached || sv != _scrollView) return;
  [self handleScrollOffset:sv.contentOffset force:NO];
  if (!_inPreDraw) {
    [self applyPreDraw];
  }
  [self updateDisplayLinkState];
}

- (void)onScrollViewWillBeginDragging:(UIScrollView*)sv {
  if (_detached || sv != _scrollView) return;
  if (_inMomentum) {
    _inMomentum = NO;
    [self foldMomentumMvcpShift];
    if (auto state = EngineRegistry::instance().find(_engineId)) {
      state->onNativeMomentumEnd(_horizontal ? sv.contentOffset.x : sv.contentOffset.y);
    }
  }
}

- (void)finishScrollLanding:(UIScrollView*)sv {
  if (_detached || sv != _scrollView) return;
  _inMomentum = NO;
  _lastVelocity = 0.0;
  [self foldMomentumMvcpShift];
  if (auto state = EngineRegistry::instance().find(_engineId)) {
    state->onNativeMomentumEnd(_horizontal ? sv.contentOffset.x : sv.contentOffset.y);
  }
  [self handleScrollOffset:sv.contentOffset force:YES];
  if (!_inPreDraw) {
    [self applyPreDraw];
  }
  [self updateDisplayLinkState];
}

- (void)onScrollViewDidEndDragging:(UIScrollView*)sv willDecelerate:(BOOL)decelerate {
  if (!decelerate) {
    [self finishScrollLanding:sv];
  }
}

- (void)onScrollViewWillBeginDecelerating:(UIScrollView*)sv {
  if (_detached || sv != _scrollView) return;
  _inMomentum = YES;
}

- (void)onScrollViewDidEndDecelerating:(UIScrollView*)sv {
  [self finishScrollLanding:sv];
}

- (void)onScrollViewDidEndScrollingAnimation:(UIScrollView*)sv {
  [self finishScrollLanding:sv];
}

- (void)onScrollViewDidScrollToTop:(UIScrollView*)sv {
  [self finishScrollLanding:sv];
}

- (void)onDisplayLink:(CADisplayLink*)link {
  if (_detached) {
    [link invalidate];
    return;
  }
  if (_needsAttach) {
    if (![self ensureAttachedOnMain]) {
      _attachFrameRetries++;
      if (_attachFrameRetries >= kMaxAttachFrameRetries) {
        _needsAttach = NO;
      }
      [self updateDisplayLinkState];
    }
    return;
  }
  UIScrollView* sv = _scrollView;
  if (sv != nil && sv.window != nil) {
    const double curPt = _horizontal ? sv.contentOffset.x : sv.contentOffset.y;
    if (_needsPacing) {
      _needsPacing = NO;
      [self handleScrollOffset:sv.contentOffset force:NO];
    } else if (!std::isnan(_lastHandledOffset) && std::abs(curPt - _lastHandledOffset) > 0.25) {
      [self handleScrollOffset:sv.contentOffset force:NO];
    }
  }
  [self applyPreDraw];
  [self updateDisplayLinkState];
}

- (void)handleScrollOffset:(CGPoint)offset force:(BOOL)force {
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
    if (sv != nil) {
      state->onNativeMomentumEnd(_horizontal ? sv.contentOffset.x : sv.contentOffset.y);
    }
  }
  _inMomentum = nowMomentum;

  if (!force && _inMomentum && vpPt > 0.0 && stepPt > vpPt * kSupersonicStepViewports) {
    return;
  }

  const double curPt = sv != nil ? (_horizontal ? sv.contentOffset.x : sv.contentOffset.y) : offsetPt;
  _lastHandledOffset = curPt;
  const double effectiveOffsetPt = curPt + _mvcpMomentumShift;
  const int32_t budget = (!force && std::abs(_lastVelocity) > kFlingPacingVelocityPtS) ? 8 : 0;
  const double inflightJsMs =
      _jsWakeSentTime > 0.0 ? std::max(0.0, (now - _jsWakeSentTime) * 1000.0) : 0.0;
  const double jsLatency =
      _templateEngine.isActive ? -1.0 : std::max(_jsLatencyMs, inflightJsMs);
  std::vector<SlotDelta> deltas;
  const auto res =
      state->onNativeScroll(effectiveOffsetPt, _lastVelocity, budget, !_inMomentum, deltas, jsLatency);

  [self ensureBufferCapacity:static_cast<size_t>(std::max(0, res.slotCount)) + 16];
  if (res.deltaCount > 0 || res.changed) {
    _preDrawDirty = YES;
    _transformsDirty = YES;
  }
  _needsPacing = res.hasMorePending ? YES : NO;

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
    [self updateDisplayLinkState];
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
    if (!deltas.empty() && _jsWakeSentTime <= 0.0) {
      _jsWakeSentTime = now;
    }
    std::shared_ptr<ArrayBuffer> ab;
    if (!deltas.empty()) {
      std::vector<int32_t> packed(deltas.size() * 4, 0);
      for (size_t k = 0; k < deltas.size(); ++k) {
        packed[k * 4 + 0] = deltas[k].slotId;
        packed[k * 4 + 1] = deltas[k].itemIndex;
        packed[k * 4 + 2] = static_cast<int32_t>(deltas[k].generation);
        packed[k * 4 + 3] = static_cast<int32_t>(deltas[k].flags);
      }
      ab = ArrayBuffer::copy(reinterpret_cast<const uint8_t*>(packed.data()),
                             deltas.size() * 4 * sizeof(int32_t));
      _pendingAwaitingGenCount =
          std::max(_pendingAwaitingGenCount, static_cast<int32_t>(deltas.size()));
    } else {
      ab = ArrayBuffer::allocate(4);
    }
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
  [self updateDisplayLinkState];
}

- (void)foldMomentumMvcpShift {
  if (std::abs(_mvcpMomentumShift) < 0.25) {
    _mvcpMomentumShift = 0.0;
    return;
  }
  UIScrollView* sv = _scrollView;
  if (sv == nil) return;
  const double shift = _mvcpMomentumShift;
  CGPoint pt = sv.contentOffset;
  const double cur = _horizontal ? pt.x : pt.y;
  const double desired = std::max(0.0, cur + shift);
  const double maxScroll = _horizontal
                               ? std::max(0.0, sv.contentSize.width - sv.bounds.size.width)
                               : std::max(0.0, sv.contentSize.height - sv.bounds.size.height);
  if (shift > 0.0 && desired > maxScroll + 0.5) {
    // Wait for Fabric to grow contentSize before folding a positive prepend shift.
    return;
  }
  _mvcpMomentumShift = 0.0;
  if (_horizontal) pt.x = desired;
  else pt.y = desired;
  _lastOffset = desired;
  _lastHandledOffset = desired;
  _suppressVelocity = YES;
  sv.contentOffset = pt;
  _suppressVelocity = NO;
  for (auto& kv : _slotViews) {
    kv.second.appliedTargetPt = NAN;
  }
  _preDrawDirty = YES;
  _transformsDirty = YES;
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
                   const double cur = strongSelf->_horizontal ? pt.x : pt.y;
                   const double desired = std::max(0.0, cur + mvcpDeltaPt);
                   if (strongSelf->_horizontal) pt.x = desired;
                   else pt.y = desired;
                   strongSelf->_lastOffset = desired;
                   strongSelf->_lastHandledOffset = desired;
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
    _preDrawDirty = NO;
    _transformsDirty = NO;
  }
}

- (void)applyStickyIndex:(int32_t)stickyIndex translate:(double)translatePt {
  if (_stickyViewTag <= 0) return;
  UIView* sticky = _stickyView;
  if (sticky == nil || sticky.window == nil || sticky.tag != _stickyViewTag) {
    sticky = findReactViewByTag(_stickyViewTag);
    _stickyView = sticky;
  }
  if (sticky == nil) return;
  if (stickyIndex < 0) {
    if (!sticky.hidden) sticky.hidden = YES;
    return;
  }
  if (sticky.hidden) sticky.hidden = NO;
  const CGAffineTransform nextTransform =
      _horizontal ? CGAffineTransformMakeTranslation(translatePt, 0)
                  : CGAffineTransformMakeTranslation(0, translatePt);
  if (!CGAffineTransformEqualToTransform(sticky.transform, nextTransform)) {
    markTransformManagedByNative(sticky);
    sticky.transform = nextTransform;
  }
}

- (UIView*)resolveSlotViewForId:(int32_t)slotId record:(IosSlotRecord&)rec {
  UIView* view = _slotViewCache[slotId];
  if (view != nil && view.window != nil && view.tag == rec.viewTag) {
    return view;
  }
  view = findReactViewByTag(rec.viewTag);
  if (view != nil) {
    markTransformManagedByNative(view);
    _slotViewCache[slotId] = view;
    rec.appliedGen = 0;
    rec.appliedTargetPt = NAN;
    rec.appliedBaseOrigin = NAN;
    rec.appliedVisible = -1;
    rec.zeroMeasureFrames = 0;
  }
  return view;
}

- (void)applyPreDraw {
  if (_inPreDraw || _detached) return;
  _inPreDraw = YES;
  @try {
    if (_scrollView == nil || _scrollView.window == nil) {
      [self ensureAttachedOnMain];
    }

    UIScrollView* sv = _scrollView;
    if (sv != nil) {
      if (_inMomentum && !sv.isDecelerating) {
        _inMomentum = NO;
        [self foldMomentumMvcpShift];
        if (auto st = EngineRegistry::instance().find(_engineId)) {
          st->onNativeMomentumEnd(_horizontal ? sv.contentOffset.x : sv.contentOffset.y);
        }
      } else if (!_inMomentum && std::abs(_mvcpMomentumShift) >= 0.25) {
        [self foldMomentumMvcpShift];
      }
    }

    if (_templateEngine.isActive) {
      [self runTemplateSync];
      return;
    }

    if (!_preDrawDirty && _pendingAwaitingGenCount == 0 && std::abs(_mvcpMomentumShift) < 0.25) {
      return;
    }

    auto state = EngineRegistry::instance().find(_engineId);
    if (state == nullptr) return;
    [self ensureBufferCapacity:_slotViews.size() + 16];

    double totalSize = 0.0;
    int32_t stickyIndex = -1;
    double stickyTrans = 0.0;
    double pendingMvcp = 0.0;
    int32_t slotCount = state->readSlotTransforms(
        _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
        totalSize, stickyIndex, stickyTrans, &pendingMvcp);
    if (slotCount > static_cast<int32_t>(_offsetsBuf.size())) {
      [self ensureBufferCapacity:static_cast<size_t>(slotCount) + 16];
      slotCount = state->readSlotTransforms(
          _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
          totalSize, stickyIndex, stickyTrans, &pendingMvcp);
    }
    if (std::abs(pendingMvcp) > 0.1) {
      _mvcpMomentumShift += pendingMvcp;
      if (sv != nil && !sv.isDecelerating) {
        [self foldMomentumMvcpShift];
      }
    }

    const BOOL fullPass = _preDrawDirty || _transformsDirty;
    std::vector<int32_t> sizeIds;
    std::vector<double> sizeVals;
    std::vector<uint32_t> sizeGens;
    std::vector<int32_t> seenGens(static_cast<size_t>(std::max(0, slotCount)), -1);
    int32_t newlyReadyCount = 0;
    int32_t firstPassUnreadyCount = 0;

    for (int32_t s = 0; s < slotCount; ++s) {
      if (_metaBuf[static_cast<size_t>(s) * 3] == 0) {
        seenGens[static_cast<size_t>(s)] = 0;
        continue;
      }
      auto it = _slotViews.find(s);
      if (it == _slotViews.end()) {
        firstPassUnreadyCount++;
        continue;
      }
      const uint32_t expectedGen = static_cast<uint32_t>(_metaBuf[static_cast<size_t>(s) * 3 + 1]);
      const bool measures = _metaBuf[static_cast<size_t>(s) * 3 + 2] != 0;
      const bool needsInitialMeasure =
          measures && it->second.lastMeasuredGen != expectedGen && it->second.zeroMeasureFrames < 10;
      if (!fullPass && it->second.appliedGen == expectedGen && !needsInitialMeasure) {
        seenGens[static_cast<size_t>(s)] = static_cast<int32_t>(expectedGen);
        continue;
      }
      UIView* view = [self resolveSlotViewForId:s record:it->second];
      if (view == nil) {
        firstPassUnreadyCount++;
        continue;
      }
      const uint32_t seenGen =
          (it->second.appliedGen == expectedGen) ? expectedGen : parseGenerationFromView(view);
      seenGens[static_cast<size_t>(s)] = static_cast<int32_t>(seenGen);
      if (seenGen != expectedGen) {
        firstPassUnreadyCount++;
        continue;
      }
      if (it->second.appliedGen != expectedGen) newlyReadyCount++;
      if (!measures) continue;
      const double measured = _horizontal ? view.bounds.size.width : view.bounds.size.height;
      if (measured > 0.0) {
        it->second.zeroMeasureFrames = 0;
        if (seenGen != it->second.lastMeasuredGen ||
            std::abs(measured - it->second.lastMeasuredSize) > 0.125) {
          it->second.lastMeasuredGen = seenGen;
          it->second.lastMeasuredSize = measured;
          sizeIds.push_back(s);
          sizeVals.push_back(measured);
          sizeGens.push_back(seenGen);
        }
      } else if (seenGen != it->second.lastMeasuredGen && it->second.zeroMeasureFrames < 10) {
        it->second.zeroMeasureFrames++;
        firstPassUnreadyCount++;
      }
    }

    if (!fullPass && sizeIds.empty() && newlyReadyCount == 0 && std::abs(_mvcpMomentumShift) < 0.25) {
      _pendingAwaitingGenCount = firstPassUnreadyCount;
      return;
    }

    BOOL layoutChanged = NO;
    if (!sizeIds.empty()) {
      const auto szRes = state->onNativeSlotSizes(
          sizeIds.data(), sizeVals.data(), sizeGens.data(),
          static_cast<int32_t>(sizeIds.size()), _mvcpEnabled);
      if (szRes.changed) {
        layoutChanged = YES;
        if (_mvcpEnabled && std::abs(szRes.mvcpDeltaDp) > 0.1) {
          if (_inMomentum) {
            _mvcpMomentumShift += szRes.mvcpDeltaDp;
          } else if (sv != nil) {
            CGPoint pt = sv.contentOffset;
            const double cur = _horizontal ? pt.x : pt.y;
            const double desired = std::max(0.0, cur + szRes.mvcpDeltaDp);
            if (_horizontal) pt.x = desired;
            else pt.y = desired;
            _lastOffset = desired;
            _lastHandledOffset = desired;
            _suppressVelocity = YES;
            sv.contentOffset = pt;
            _suppressVelocity = NO;
          }
        }
        double extraMvcp = 0.0;
        slotCount = state->readSlotTransforms(
            _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
            totalSize, stickyIndex, stickyTrans, &extraMvcp);
        if (slotCount > static_cast<int32_t>(_offsetsBuf.size())) {
          [self ensureBufferCapacity:static_cast<size_t>(slotCount) + 16];
          slotCount = state->readSlotTransforms(
              _offsetsBuf.data(), _metaBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
              totalSize, stickyIndex, stickyTrans, &extraMvcp);
        }
        if (std::abs(extraMvcp) > 0.1) {
          _mvcpMomentumShift += extraMvcp;
          if (sv != nil && !sv.isDecelerating) {
            [self foldMomentumMvcpShift];
          }
        }
        if (_onContentSize && std::abs(szRes.totalSizeDp - _lastReportedTotal) > 0.5) {
          _lastReportedTotal = szRes.totalSizeDp;
          _lastReportedVersion = szRes.layoutVersion;
          _onContentSize(szRes.totalSizeDp, static_cast<double>(szRes.layoutVersion));
        }
      }
    }

    const double scrollPt = sv != nil ? (_horizontal ? sv.contentOffset.x : sv.contentOffset.y) : 0.0;
    const double vpPt = sv != nil ? (_horizontal ? sv.bounds.size.width : sv.bounds.size.height) : 0.0;
    int32_t awaitingCount = 0;

    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (int32_t s = 0; s < slotCount; ++s) {
      const bool active = _metaBuf[static_cast<size_t>(s) * 3] != 0;
      auto it = _slotViews.find(s);
      if (it == _slotViews.end()) {
        if (active) awaitingCount++;
        continue;
      }
      const uint32_t expectedGen = static_cast<uint32_t>(_metaBuf[static_cast<size_t>(s) * 3 + 1]);
      if (!fullPass && !layoutChanged && active && it->second.appliedGen == expectedGen &&
          it->second.appliedVisible == 1 && std::abs(_mvcpMomentumShift) < 0.25) {
        continue;
      }
      UIView* view = [self resolveSlotViewForId:s record:it->second];
      if (view == nil) {
        if (active) awaitingCount++;
        continue;
      }
      if (!active) {
        if (it->second.appliedVisible != 0) {
          if (!view.hidden) view.hidden = YES;
          it->second.appliedVisible = 0;
        }
        continue;
      }
      const uint32_t seenGen =
          (static_cast<size_t>(s) < seenGens.size() && seenGens[static_cast<size_t>(s)] >= 0)
              ? static_cast<uint32_t>(seenGens[static_cast<size_t>(s)])
              : parseGenerationFromView(view);
      if (seenGen != expectedGen) {
        // Keep already-offscreen awaiting slots untouched; hide onscreen or newly created ones.
        const double prevPt = it->second.appliedTargetPt;
        const double prevSize = _horizontal ? view.bounds.size.width : view.bounds.size.height;
        const bool alreadyOffscreen = !std::isnan(prevPt) && prevSize > 0.0 && vpPt > 0.0 &&
                                      (prevPt + prevSize <= scrollPt || prevPt >= scrollPt + vpPt);
        if (!alreadyOffscreen && it->second.appliedVisible != 0) {
          if (!view.hidden) view.hidden = YES;
          it->second.appliedVisible = 0;
        }
        awaitingCount++;
        continue;
      }
      const bool measures = _metaBuf[static_cast<size_t>(s) * 3 + 2] != 0;
      const double curSize = _horizontal ? view.bounds.size.width : view.bounds.size.height;
      if (measures && curSize <= 0.0 && it->second.lastMeasuredGen != seenGen &&
          it->second.zeroMeasureFrames < 10) {
        awaitingCount++;
      }
      const double target = _offsetsBuf[static_cast<size_t>(s)] - _mvcpMomentumShift;
      const double baseOrigin = viewBaseOrigin(view, _horizontal);
      const double rel = target - baseOrigin;
      const CGAffineTransform desiredTransform =
          _horizontal ? CGAffineTransformMakeTranslation(rel, 0)
                      : CGAffineTransformMakeTranslation(0, rel);
      if (it->second.appliedGen != expectedGen || std::isnan(it->second.appliedTargetPt) ||
          std::abs(it->second.appliedTargetPt - target) > 0.05 ||
          std::isnan(it->second.appliedBaseOrigin) ||
          std::abs(it->second.appliedBaseOrigin - baseOrigin) > 0.05 ||
          !CGAffineTransformEqualToTransform(view.transform, desiredTransform)) {
        markTransformManagedByNative(view);
        view.transform = desiredTransform;
        it->second.appliedGen = expectedGen;
        it->second.appliedTargetPt = target;
        it->second.appliedBaseOrigin = baseOrigin;
      }
      if (it->second.appliedVisible != 1) {
        if (view.hidden) view.hidden = NO;
        it->second.appliedVisible = 1;
      }
    }
    [self applyStickyIndex:stickyIndex translate:stickyTrans];
    [CATransaction commit];

    _pendingAwaitingGenCount = awaitingCount;
    _preDrawDirty = NO;
    _transformsDirty = NO;
    if (_jsWakeSentTime > 0.0 && awaitingCount == 0) {
      const double rttMs = std::max(1.0, (CACurrentMediaTime() - _jsWakeSentTime) * 1000.0);
      _jsLatencyMs = _jsLatencyMs * 0.5 + rttMs * 0.5;
      _jsWakeSentTime = 0.0;
    }
  } @finally {
    _inPreDraw = NO;
  }
}

- (void)applyExternalMvcpShift:(double)deltaPt {
  if (_detached || !std::isfinite(deltaPt) || deltaPt == 0.0) return;
  if (_scrollView == nil || _scrollView.window == nil) {
    _attachFrameRetries = 0;
    [self ensureAttachedOnMain];
  }
  _mvcpMomentumShift += deltaPt;
  _preDrawDirty = YES;
  _transformsDirty = YES;
  UIScrollView* sv = _scrollView;
  _inMomentum = sv != nil && sv.isDecelerating;
  if (!_inMomentum) {
    [self foldMomentumMvcpShift];
  }
  [self applyPreDraw];
  [self updateDisplayLinkState];
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
    [session ensureAttachedOnMain];
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
    resetNativeManagedView(session.stickyView, session.stickyViewTag);
    session.stickyViewTag = tag;
    session.stickyView = nil;
    [session markStickyUpdated];
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
    [session ensureAttachedOnMain];
    if (UIScrollView* sv = session.scrollView) {
      [session handleScrollOffset:sv.contentOffset force:YES];
    }
    [session applyPreDraw];
  });
}

void HybridNitroListNativeHost::syncNow(double hostId) {
  NLHostSessionObjC* session = findIosHost(static_cast<int32_t>(hostId));
  if (session == nil) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [session markDirtyAndSyncNow];
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
    [session ensureAttachedOnMain];
    UIView* resolved = findReactViewByTag(tag);
    [session.templateEngine setContainerTag:tag numColumns:cols crossAxisGapPt:gap resolved:resolved];
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      const double curPt = session.horizontal ? sv.contentOffset.x : sv.contentOffset.y;
      if (state == nullptr || !state->isJsPrewarmActiveAtOffset(curPt)) {
        [session handleScrollOffset:sv.contentOffset force:YES];
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
    [session ensureAttachedOnMain];
    [session.templateEngine setSchemaJson:json];
    session.templateLoadNotified = NO;
    session.templateReportedContainerPt = 0.0;
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      const double curPt = session.horizontal ? sv.contentOffset.x : sv.contentOffset.y;
      if (state == nullptr || !state->isJsPrewarmActiveAtOffset(curPt)) {
        [session handleScrollOffset:sv.contentOffset force:YES];
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
    [session ensureAttachedOnMain];
    [session.templateEngine setDataChunkStart:s
                                        count:c
                                   totalCount:t
                                        reset:reset ? YES : NO
                                        bytes:static_cast<const uint8_t*>(copy.bytes)
                                       length:copy.length];
    auto state = EngineRegistry::instance().find(session.engineId);
    if (UIScrollView* sv = session.scrollView) {
      const double curPt = session.horizontal ? sv.contentOffset.x : sv.contentOffset.y;
      if (state == nullptr || !state->isJsPrewarmActiveAtOffset(curPt)) {
        [session handleScrollOffset:sv.contentOffset force:YES];
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
