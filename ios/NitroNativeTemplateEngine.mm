#import "NitroNativeTemplateEngine.h"

#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace margelo::nitro::nitrolist;

namespace {

constexpr int32_t kAlignStretch = 0;
constexpr int32_t kAlignStart = 1;
constexpr int32_t kAlignCenter = 2;
constexpr int32_t kAlignEnd = 3;
constexpr size_t kMaxChunks = 32;

inline int32_t readInt32LE(const uint8_t* ptr, size_t offset) {
  int32_t val = 0;
  std::memcpy(&val, ptr + offset, sizeof(int32_t));
  return val;
}

inline float readFloatLE(const uint8_t* ptr, size_t offset) {
  float val = 0.0f;
  std::memcpy(&val, ptr + offset, sizeof(float));
  return val;
}

UIColor* parseColorCached(NSString* raw) {
  if (raw == nil || raw.length == 0) return UIColor.clearColor;
  static NSMutableDictionary<NSString*, UIColor*>* cache = nil;
  if (cache == nil) cache = [NSMutableDictionary dictionaryWithCapacity:32];
  UIColor* existing = cache[raw];
  if (existing != nil) return existing;

  UIColor* parsed = UIColor.clearColor;
  if ([raw isEqualToString:@"transparent"]) {
    parsed = UIColor.clearColor;
  } else if ([raw hasPrefix:@"#"]) {
    NSString* hex = [raw substringFromIndex:1];
    unsigned long long val = 0;
    NSScanner* scanner = [NSScanner scannerWithString:hex];
    if ([scanner scanHexLongLong:&val]) {
      if (hex.length == 3) {
        CGFloat r = ((val >> 8) & 0xF) / 15.0;
        CGFloat g = ((val >> 4) & 0xF) / 15.0;
        CGFloat b = (val & 0xF) / 15.0;
        parsed = [UIColor colorWithRed:r green:g blue:b alpha:1.0];
      } else if (hex.length == 6) {
        CGFloat r = ((val >> 16) & 0xFF) / 255.0;
        CGFloat g = ((val >> 8) & 0xFF) / 255.0;
        CGFloat b = (val & 0xFF) / 255.0;
        parsed = [UIColor colorWithRed:r green:g blue:b alpha:1.0];
      } else if (hex.length == 8) {
        CGFloat r = ((val >> 24) & 0xFF) / 255.0;
        CGFloat g = ((val >> 16) & 0xFF) / 255.0;
        CGFloat b = ((val >> 8) & 0xFF) / 255.0;
        CGFloat a = (val & 0xFF) / 255.0;
        parsed = [UIColor colorWithRed:r green:g blue:b alpha:a];
      }
    }
  }
  if (cache.count < 256) {
    cache[raw] = parsed;
  }
  return parsed;
}

int32_t parseAlignString(NSString* raw) {
  if (raw == nil) return -1;
  if ([raw isEqualToString:@"flex-start"]) return kAlignStart;
  if ([raw isEqualToString:@"center"]) return kAlignCenter;
  if ([raw isEqualToString:@"flex-end"]) return kAlignEnd;
  if ([raw isEqualToString:@"stretch"]) return kAlignStretch;
  return -1;
}

UIFontWeight fontWeightFromInt(int32_t fw) {
  if (fw >= 700) return UIFontWeightBold;
  if (fw >= 600) return UIFontWeightSemibold;
  if (fw >= 500) return UIFontWeightMedium;
  return UIFontWeightRegular;
}

UIImage* decodeImageOffThread(UIImage* img) {
  if (img == nil) return nil;
  if (@available(iOS 15.0, *)) {
    UIImage* prepared = [img imageByPreparingForDisplay];
    if (prepared != nil) return prepared;
  }
  return img;
}

// ---- Shared iOS UIImage Memory Cache + Background Loader/Prefetcher ----

NSCache<NSString*, UIImage*>* sharedTemplateImageCache() {
  static NSCache<NSString*, UIImage*>* cache = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    cache = [[NSCache alloc] init];
    cache.countLimit = 128;
    cache.totalCostLimit = 48 * 1024 * 1024;
  });
  return cache;
}

NSUInteger estimateImageCost(UIImage* img) {
  if (img == nil) return 0;
  CGImageRef cg = img.CGImage;
  if (cg != nil) {
    return CGImageGetBytesPerRow(cg) * CGImageGetHeight(cg);
  }
  return static_cast<NSUInteger>(img.size.width * img.size.height * img.scale * img.scale * 4.0);
}

UIImage* loadLocalImageSync(NSString* rawUri) {
  if (rawUri == nil || rawUri.length == 0) return nil;
  if ([rawUri hasPrefix:@"file://"]) {
    NSURL* url = [NSURL URLWithString:rawUri];
    if (url.path != nil) {
      return [UIImage imageWithContentsOfFile:url.path];
    }
  } else if ([rawUri hasPrefix:@"/"]) {
    return [UIImage imageWithContentsOfFile:rawUri];
  } else if ([rawUri rangeOfString:@":"].location == NSNotFound) {
    UIImage* named = [UIImage imageNamed:rawUri];
    if (named != nil) return named;
    NSString* bundlePath = [[NSBundle mainBundle] pathForResource:rawUri ofType:nil];
    if (bundlePath != nil) return [UIImage imageWithContentsOfFile:bundlePath];
  }
  return nil;
}

void fetchTemplateImage(NSString* rawUri, void (^completion)(UIImage* _Nullable image)) {
  if (rawUri == nil || rawUri.length == 0) {
    if (completion != nil) completion(nil);
    return;
  }
  NSCache<NSString*, UIImage*>* cache = sharedTemplateImageCache();
  UIImage* cached = [cache objectForKey:rawUri];
  if (cached != nil) {
    if (completion != nil) completion(cached);
    return;
  }
  if (![rawUri hasPrefix:@"http://"] && ![rawUri hasPrefix:@"https://"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      UIImage* loaded = decodeImageOffThread(loadLocalImageSync(rawUri));
      if (loaded != nil) {
        [cache setObject:loaded forKey:rawUri cost:estimateImageCost(loaded)];
      }
      if (completion != nil) {
        dispatch_async(dispatch_get_main_queue(), ^{
          completion(loaded);
        });
      }
    });
    return;
  }
  NSURL* url = [NSURL URLWithString:rawUri];
  if (url == nil) {
    if (completion != nil) completion(nil);
    return;
  }
  NSMutableURLRequest* req =
      [NSMutableURLRequest requestWithURL:url
                              cachePolicy:NSURLRequestReturnCacheDataElseLoad
                          timeoutInterval:15.0];
  NSURLSessionDataTask* task =
      [[NSURLSession sharedSession]
          dataTaskWithRequest:req
            completionHandler:^(NSData* data, NSURLResponse* /* response */, NSError* error) {
              UIImage* decoded = nil;
              if (error == nil && data != nil && data.length > 0) {
                UIImage* raw = [UIImage imageWithData:data];
                decoded = decodeImageOffThread(raw);
                if (decoded != nil) {
                  [cache setObject:decoded forKey:rawUri cost:estimateImageCost(decoded)];
                }
              }
              if (completion != nil) {
                dispatch_async(dispatch_get_main_queue(), ^{
                  completion(decoded);
                });
              }
            }];
  [task resume];
}

// ---- Compiled Schema AST ----

struct NodeSpec {
  std::string type;
  UIColor* bgColor = nil;
  bool hasBg = false;
  int32_t bgColorField = -1;
  CGFloat borderRadius = 0.0;
  CGFloat borderBottomWidth = 0.0;
  UIColor* borderBottomColor = nil;
  CGFloat padL = 0.0;
  CGFloat padT = 0.0;
  CGFloat padR = 0.0;
  CGFloat padB = 0.0;
  CGFloat marginTop = 0.0;
  CGFloat marginBottom = 0.0;
  CGFloat gap = 0.0;
  CGFloat width = -1.0;
  CGFloat height = -1.0;
  CGFloat maxWidthPercent = -1.0;
  int32_t alignItems = kAlignStretch;
  int32_t alignSelf = -1;
  int32_t alignSelfField = -1;
  int32_t visibleField = -1;
  std::string pressAction;
  NSString* staticText = nil;
  int32_t textField = -1;
  CGFloat fontSize = 14.0;
  int32_t fontWeight = 400;
  CGFloat lineHeight = 0.0;
  UIColor* textColor = nil;
  int32_t textColorField = -1;
  int32_t maxLines = 0;
  NSString* staticUri = nil;
  int32_t uriField = -1;
  CGFloat aspectRatio = 0.0;
  int32_t aspectRatioField = -1;
  int32_t resizeMode = 0;
  std::vector<NodeSpec> children;
};

struct TemplateSchema {
  int32_t numStrFields = 0;
  int32_t numNumFields = 0;
  int32_t nativeIdFieldIdx = -1;
  NSString* nativeIdPrefix = @"";
  int32_t testIdFieldIdx = -1;
  std::vector<int32_t> imageFieldIndices;
  std::vector<NodeSpec> roots;
};

NodeSpec parseNodeSpec(NSDictionary* obj) {
  NodeSpec s;
  NSString* typeStr = [obj[@"t"] isKindOfClass:[NSString class]] ? obj[@"t"] : @"box";
  s.type = typeStr.UTF8String;
  if ([obj[@"bg"] isKindOfClass:[NSString class]]) {
    s.hasBg = true;
    s.bgColor = parseColorCached(obj[@"bg"]);
  } else {
    s.bgColor = UIColor.clearColor;
  }
  if (obj[@"bgF"] != nil) s.bgColorField = [obj[@"bgF"] intValue];
  if (obj[@"br"] != nil) s.borderRadius = [obj[@"br"] doubleValue];
  if (obj[@"bbw"] != nil) s.borderBottomWidth = [obj[@"bbw"] doubleValue];
  if ([obj[@"bbc"] isKindOfClass:[NSString class]]) {
    s.borderBottomColor = parseColorCached(obj[@"bbc"]);
  } else {
    s.borderBottomColor = UIColor.clearColor;
  }
  if (obj[@"pl"] != nil) s.padL = [obj[@"pl"] doubleValue];
  if (obj[@"pt"] != nil) s.padT = [obj[@"pt"] doubleValue];
  if (obj[@"pr"] != nil) s.padR = [obj[@"pr"] doubleValue];
  if (obj[@"pb"] != nil) s.padB = [obj[@"pb"] doubleValue];
  if (obj[@"mt"] != nil) s.marginTop = [obj[@"mt"] doubleValue];
  if (obj[@"mb"] != nil) s.marginBottom = [obj[@"mb"] doubleValue];
  if (obj[@"gap"] != nil) s.gap = [obj[@"gap"] doubleValue];
  if (obj[@"w"] != nil) s.width = [obj[@"w"] doubleValue];
  if (obj[@"h"] != nil) s.height = [obj[@"h"] doubleValue];
  if (obj[@"mwp"] != nil) s.maxWidthPercent = [obj[@"mwp"] doubleValue];
  if (obj[@"ai"] != nil) s.alignItems = [obj[@"ai"] intValue];
  if (obj[@"as"] != nil) s.alignSelf = [obj[@"as"] intValue];
  if (obj[@"asF"] != nil) s.alignSelfField = [obj[@"asF"] intValue];
  if (obj[@"visF"] != nil) s.visibleField = [obj[@"visF"] intValue];
  if ([obj[@"act"] isKindOfClass:[NSString class]]) {
    s.pressAction = [obj[@"act"] UTF8String];
  }
  if ([obj[@"txt"] isKindOfClass:[NSString class]]) s.staticText = obj[@"txt"];
  if (obj[@"txtF"] != nil) s.textField = [obj[@"txtF"] intValue];
  if (obj[@"fs"] != nil) s.fontSize = [obj[@"fs"] doubleValue];
  if (obj[@"fw"] != nil) s.fontWeight = [obj[@"fw"] intValue];
  if (obj[@"lh"] != nil) s.lineHeight = [obj[@"lh"] doubleValue];
  if ([obj[@"col"] isKindOfClass:[NSString class]]) {
    s.textColor = parseColorCached(obj[@"col"]);
  } else {
    s.textColor = UIColor.blackColor;
  }
  if (obj[@"colF"] != nil) s.textColorField = [obj[@"colF"] intValue];
  if (obj[@"ml"] != nil) s.maxLines = [obj[@"ml"] intValue];
  if ([obj[@"uri"] isKindOfClass:[NSString class]]) s.staticUri = obj[@"uri"];
  if (obj[@"uriF"] != nil) s.uriField = [obj[@"uriF"] intValue];
  if (obj[@"ar"] != nil) s.aspectRatio = [obj[@"ar"] doubleValue];
  if (obj[@"arF"] != nil) s.aspectRatioField = [obj[@"arF"] intValue];
  if (obj[@"rm"] != nil) s.resizeMode = [obj[@"rm"] intValue];

  NSArray* ch = [obj[@"ch"] isKindOfClass:[NSArray class]] ? obj[@"ch"] : nil;
  if (ch != nil) {
    s.children.reserve(ch.count);
    for (id item in ch) {
      if ([item isKindOfClass:[NSDictionary class]]) {
        s.children.push_back(parseNodeSpec((NSDictionary*)item));
      }
    }
  }
  return s;
}

std::shared_ptr<TemplateSchema> parseTemplateSchema(NSString* jsonStr) {
  NSData* data = [jsonStr dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) return nullptr;
  NSError* err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
  if (err != nil || ![parsed isKindOfClass:[NSDictionary class]]) return nullptr;
  NSDictionary* root = (NSDictionary*)parsed;
  auto schema = std::make_shared<TemplateSchema>();
  schema->numStrFields = [root[@"ns"] intValue];
  schema->numNumFields = [root[@"nn"] intValue];
  schema->nativeIdFieldIdx = root[@"nidF"] != nil ? [root[@"nidF"] intValue] : -1;
  schema->nativeIdPrefix = [root[@"nidP"] isKindOfClass:[NSString class]] ? root[@"nidP"] : @"";
  schema->testIdFieldIdx = root[@"tidF"] != nil ? [root[@"tidF"] intValue] : -1;
  NSArray* imgFs = [root[@"imgFs"] isKindOfClass:[NSArray class]] ? root[@"imgFs"] : nil;
  for (NSNumber* n in imgFs) {
    schema->imageFieldIndices.push_back(n.intValue);
  }
  NSArray* tmpls = [root[@"tmpls"] isKindOfClass:[NSArray class]] ? root[@"tmpls"] : nil;
  for (id item in tmpls) {
    if ([item isKindOfClass:[NSDictionary class]]) {
      NSDictionary* entry = (NSDictionary*)item;
      if ([entry[@"root"] isKindOfClass:[NSDictionary class]]) {
        schema->roots.push_back(parseNodeSpec((NSDictionary*)entry[@"root"]));
      }
    }
  }
  if (schema->roots.empty()) return nullptr;
  return schema;
}

// ---- Compact Binary Data Store ----

struct DataChunk {
  int32_t chunkId = 0;
  int32_t startIndex = 0;
  int32_t count = 0;
  int32_t numStrFields = 0;
  int32_t numNumFields = 0;
  int32_t strPoolOffset = 0;
  size_t numBase = 0;
  size_t strTableBase = 0;
  std::vector<uint8_t> bytes;
  std::unordered_map<int32_t, NSString*> stringCache;
  std::unordered_map<int32_t, UIColor*> colorCache;
  std::unordered_map<int32_t, int32_t> alignCache;
  std::unordered_set<int32_t> prefetchedOffsets;

  int32_t templateIndex(int32_t localIdx) const {
    return static_cast<int32_t>(bytes[static_cast<size_t>(16 + localIdx)]);
  }

  float getNumber(int32_t localIdx, int32_t fieldIdx) const {
    if (fieldIdx < 0 || fieldIdx >= numNumFields) return NAN;
    const size_t off = numBase + static_cast<size_t>(localIdx * numNumFields + fieldIdx) * 4;
    if (off + 4 > bytes.size()) return NAN;
    return readFloatLE(bytes.data(), off);
  }

  int32_t getStringOffset(int32_t localIdx, int32_t fieldIdx) const {
    if (fieldIdx < 0 || fieldIdx >= numStrFields) return -1;
    const size_t entryBase = strTableBase + static_cast<size_t>(localIdx * numStrFields + fieldIdx) * 8;
    if (entryBase + 8 > bytes.size()) return -1;
    const int32_t len = readInt32LE(bytes.data(), entryBase + 4);
    if (len < 0) return -1;
    return readInt32LE(bytes.data(), entryBase);
  }

  int32_t getStringLength(int32_t localIdx, int32_t fieldIdx) const {
    if (fieldIdx < 0 || fieldIdx >= numStrFields) return -1;
    const size_t entryBase = strTableBase + static_cast<size_t>(localIdx * numStrFields + fieldIdx) * 8;
    if (entryBase + 8 > bytes.size()) return -1;
    return readInt32LE(bytes.data(), entryBase + 4);
  }

  NSString* getString(int32_t localIdx, int32_t fieldIdx) {
    if (fieldIdx < 0 || fieldIdx >= numStrFields) return nil;
    const size_t entryBase = strTableBase + static_cast<size_t>(localIdx * numStrFields + fieldIdx) * 8;
    if (entryBase + 8 > bytes.size()) return nil;
    const int32_t off = readInt32LE(bytes.data(), entryBase);
    const int32_t len = readInt32LE(bytes.data(), entryBase + 4);
    if (len < 0) return nil;
    if (len == 0) return @"";
    const size_t absOff = static_cast<size_t>(strPoolOffset + off);
    if (absOff + static_cast<size_t>(len) > bytes.size()) return nil;
    if (len <= 160) {
      auto it = stringCache.find(off);
      if (it != stringCache.end()) return it->second;
      NSString* str = [[NSString alloc] initWithBytes:bytes.data() + absOff
                                               length:static_cast<NSUInteger>(len)
                                             encoding:NSUTF8StringEncoding];
      if (str == nil) str = @"";
      stringCache[off] = str;
      return str;
    }
    NSString* str = [[NSString alloc] initWithBytes:bytes.data() + absOff
                                             length:static_cast<NSUInteger>(len)
                                           encoding:NSUTF8StringEncoding];
    return str != nil ? str : @"";
  }

  UIColor* getColor(int32_t localIdx, int32_t fieldIdx) {
    const int32_t off = getStringOffset(localIdx, fieldIdx);
    if (off < 0) return nil;
    auto it = colorCache.find(off);
    if (it != colorCache.end()) return it->second;
    NSString* raw = getString(localIdx, fieldIdx);
    if (raw == nil) return nil;
    UIColor* col = parseColorCached(raw);
    colorCache[off] = col;
    return col;
  }

  int32_t getAlign(int32_t localIdx, int32_t fieldIdx) {
    const int32_t off = getStringOffset(localIdx, fieldIdx);
    if (off < 0) return -1;
    auto it = alignCache.find(off);
    if (it != alignCache.end()) return it->second;
    NSString* raw = getString(localIdx, fieldIdx);
    const int32_t parsed = parseAlignString(raw);
    alignCache[off] = parsed;
    return parsed;
  }
};

class DataStore {
public:
  int32_t totalCount = 0;
  int32_t dataGeneration = 0;

  void clear() {
    chunks_.clear();
    totalCount = 0;
    dataGeneration++;
  }

  void shiftIndices(int32_t delta, int32_t total) {
    if (delta == 0) return;
    for (int32_t i = static_cast<int32_t>(chunks_.size()) - 1; i >= 0; --i) {
      auto& c = chunks_[static_cast<size_t>(i)];
      const int32_t nextStart = c->startIndex + delta;
      if (nextStart < 0 || nextStart >= total) {
        chunks_.erase(chunks_.begin() + i);
      } else {
        c->startIndex = nextStart;
      }
    }
    totalCount = total;
  }

  void putChunk(int32_t startIndex, int32_t count, int32_t total, bool reset,
                const uint8_t* data, size_t size) {
    if (size < 16 || count <= 0 || data == nullptr) return;
    const int32_t pktCount = readInt32LE(data, 0);
    const int32_t numStr = readInt32LE(data, 4);
    const int32_t numNum = readInt32LE(data, 8);
    const int32_t strPoolOff = readInt32LE(data, 12);
    if (pktCount <= 0 || strPoolOff < 16 || static_cast<size_t>(strPoolOff) > size) return;

    if (reset) {
      chunks_.clear();
    }

    auto chunk = std::make_shared<DataChunk>();
    chunk->chunkId = nextChunkId_++;
    chunk->startIndex = startIndex;
    chunk->count = pktCount;
    chunk->numStrFields = numStr;
    chunk->numNumFields = numNum;
    chunk->strPoolOffset = strPoolOff;
    const size_t tmplAligned = static_cast<size_t>((pktCount + 3) & ~3);
    chunk->numBase = 16 + tmplAligned;
    chunk->strTableBase = chunk->numBase + static_cast<size_t>(pktCount * numNum) * 4;
    chunk->bytes.assign(data, data + size);

    const int32_t endIndex = startIndex + pktCount;
    for (int32_t i = static_cast<int32_t>(chunks_.size()) - 1; i >= 0; --i) {
      const auto& c = chunks_[static_cast<size_t>(i)];
      if (c->startIndex >= total ||
          (c->startIndex < endIndex && (c->startIndex + c->count) > startIndex)) {
        chunks_.erase(chunks_.begin() + i);
      }
    }
    chunks_.push_back(chunk);
    while (chunks_.size() > kMaxChunks) {
      int32_t farIdx = -1;
      int32_t farDist = -1;
      for (int32_t k = 0; k < static_cast<int32_t>(chunks_.size()); ++k) {
        if (chunks_[static_cast<size_t>(k)].get() == chunk.get()) continue;
        const int32_t dist = std::abs(chunks_[static_cast<size_t>(k)]->startIndex - startIndex);
        if (dist > farDist) {
          farDist = dist;
          farIdx = k;
        }
      }
      if (farIdx >= 0) chunks_.erase(chunks_.begin() + farIdx);
      else break;
    }
    if (chunks_.size() > 1) {
      std::sort(chunks_.begin(), chunks_.end(),
                [](const std::shared_ptr<DataChunk>& a, const std::shared_ptr<DataChunk>& b) {
                  return a->startIndex < b->startIndex;
                });
    }
    totalCount = total;
    dataGeneration++;
  }

  DataChunk* findChunk(int32_t itemIndex) const {
    const int32_t n = static_cast<int32_t>(chunks_.size());
    if (n == 0) return nullptr;
    if (n == 1) {
      auto* c = chunks_[0].get();
      return (itemIndex >= c->startIndex && itemIndex < c->startIndex + c->count) ? c : nullptr;
    }
    int32_t lo = 0;
    int32_t hi = n - 1;
    while (lo <= hi) {
      const int32_t mid = lo + ((hi - lo) >> 1);
      auto* c = chunks_[static_cast<size_t>(mid)].get();
      if (itemIndex < c->startIndex) {
        hi = mid - 1;
      } else if (itemIndex >= c->startIndex + c->count) {
        lo = mid + 1;
      } else {
        return c;
      }
    }
    return nullptr;
  }

private:
  std::vector<std::shared_ptr<DataChunk>> chunks_;
  int32_t nextChunkId_ = 1;
};

} // namespace

// ---- Single-Pass Native UIKit Layout Views ----

@protocol NLTemplateLayoutNode <NSObject>
@property(nonatomic, assign) CGFloat nlMarginTop;
@property(nonatomic, assign) CGFloat nlMarginBottom;
@property(nonatomic, assign) CGSize nlMeasuredSize;
- (CGSize)nlMeasureForMaxWidth:(CGFloat)maxWidth exactWidth:(BOOL)exactWidth;
- (void)nlLayoutInRect:(CGRect)rect;
@end

@interface NLTemplateTapTarget : NSObject
@property(nonatomic, assign) int32_t* itemIndexPtr;
@property(nonatomic, assign) std::function<void(double, const std::string&)>* handlerPtr;
@property(nonatomic, copy) NSString* actionName;
- (void)handleTap:(UITapGestureRecognizer*)gr;
@end

@implementation NLTemplateTapTarget
- (void)handleTap:(UITapGestureRecognizer*)gr {
  (void)gr;
  if (_itemIndexPtr == nullptr || _handlerPtr == nullptr || !(*_handlerPtr)) return;
  const int32_t idx = *_itemIndexPtr;
  if (idx >= 0) {
    (*_handlerPtr)(static_cast<double>(idx), _actionName ? _actionName.UTF8String : "");
  }
}
@end

@interface NLTemplateLabel : UILabel <NLTemplateLayoutNode>
@property(nonatomic, assign) CGFloat nlMarginTop;
@property(nonatomic, assign) CGFloat nlMarginBottom;
@property(nonatomic, assign) CGSize nlMeasuredSize;
@property(nonatomic, assign) CGFloat nlLineHeight;
@property(nonatomic, assign) int32_t boundChunkId;
@property(nonatomic, assign) int32_t boundTextOffset;
@property(nonatomic, assign) int32_t boundColorOffset;
- (void)nlSetTextString:(NSString*)text;
@end

@implementation NLTemplateLabel

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _boundChunkId = -1;
    _boundTextOffset = -1;
    _boundColorOffset = -1;
    self.numberOfLines = 0;
    self.lineBreakMode = NSLineBreakByTruncatingTail;
  }
  return self;
}

- (void)nlSetTextString:(NSString*)text {
  NSString* safe = text != nil ? text : @"";
  if (_nlLineHeight > 0.0) {
    NSMutableParagraphStyle* ps = [[NSMutableParagraphStyle alloc] init];
    ps.minimumLineHeight = _nlLineHeight;
    ps.maximumLineHeight = _nlLineHeight;
    ps.lineBreakMode = self.numberOfLines > 0 ? NSLineBreakByTruncatingTail : NSLineBreakByWordWrapping;
    self.attributedText = [[NSAttributedString alloc]
        initWithString:safe
            attributes:@{
              NSFontAttributeName: self.font,
              NSForegroundColorAttributeName: self.textColor,
              NSParagraphStyleAttributeName: ps,
            }];
  } else {
    self.text = safe;
  }
}

- (CGSize)nlMeasureForMaxWidth:(CGFloat)maxWidth exactWidth:(BOOL)exactWidth {
  const CGFloat avail = std::max<CGFloat>(0.0, maxWidth);
  CGSize fit = [self sizeThatFits:CGSizeMake(avail, CGFLOAT_MAX)];
  const CGFloat w = exactWidth ? avail : std::min(avail, std::ceil(fit.width));
  const CGFloat h = std::ceil(fit.height);
  _nlMeasuredSize = CGSizeMake(w, h);
  return _nlMeasuredSize;
}

- (void)nlLayoutInRect:(CGRect)rect {
  self.frame = rect;
}

@end

@interface NLTemplateImageView : UIImageView <NLTemplateLayoutNode>
@property(nonatomic, assign) CGFloat nlMarginTop;
@property(nonatomic, assign) CGFloat nlMarginBottom;
@property(nonatomic, assign) CGSize nlMeasuredSize;
@property(nonatomic, assign) CGFloat fixedWidth;
@property(nonatomic, assign) CGFloat fixedHeight;
@property(nonatomic, assign) CGFloat dynamicAspectRatio;
@property(nonatomic, assign) int32_t boundChunkId;
@property(nonatomic, assign) int32_t boundUriOffset;
@property(nonatomic, assign) uint64_t loadGeneration;
- (void)nlLoadUri:(nullable NSString*)uri;
@end

@implementation NLTemplateImageView

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _fixedWidth = -1.0;
    _fixedHeight = -1.0;
    _boundChunkId = -1;
    _boundUriOffset = -1;
    self.clipsToBounds = YES;
  }
  return self;
}

- (void)nlLoadUri:(nullable NSString*)uri {
  const uint64_t gen = ++_loadGeneration;
  if (uri == nil || uri.length == 0) {
    self.image = nil;
    return;
  }
  UIImage* cached = [sharedTemplateImageCache() objectForKey:uri];
  if (cached != nil) {
    self.image = cached;
    return;
  }
  self.image = nil;
  __weak NLTemplateImageView* weakSelf = self;
  fetchTemplateImage(uri, ^(UIImage* _Nullable image) {
    NLTemplateImageView* strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.loadGeneration != gen) return;
    strongSelf.image = image;
  });
}

- (CGSize)nlMeasureForMaxWidth:(CGFloat)maxWidth exactWidth:(BOOL)exactWidth {
  (void)exactWidth;
  const CGFloat w = _fixedWidth > 0.0 ? _fixedWidth : std::max<CGFloat>(0.0, maxWidth);
  CGFloat h = 0.0;
  if (_fixedHeight > 0.0) {
    h = _fixedHeight;
  } else if (_dynamicAspectRatio > 0.0 && w > 0.0) {
    h = std::round(w / _dynamicAspectRatio);
  }
  _nlMeasuredSize = CGSizeMake(w, h);
  return _nlMeasuredSize;
}

- (void)nlLayoutInRect:(CGRect)rect {
  self.frame = rect;
}

@end

@interface NLTemplateBoxView : UIView <NLTemplateLayoutNode>
@property(nonatomic, assign) CGFloat nlMarginTop;
@property(nonatomic, assign) CGFloat nlMarginBottom;
@property(nonatomic, assign) CGSize nlMeasuredSize;
@property(nonatomic, assign) BOOL isRow;
@property(nonatomic, assign) CGFloat gap;
@property(nonatomic, assign) CGFloat padL;
@property(nonatomic, assign) CGFloat padT;
@property(nonatomic, assign) CGFloat padR;
@property(nonatomic, assign) CGFloat padB;
@property(nonatomic, assign) CGFloat fixedWidth;
@property(nonatomic, assign) CGFloat fixedHeight;
@property(nonatomic, assign) CGFloat maxWidthPercent;
@property(nonatomic, assign) int32_t alignItems;
@property(nonatomic, assign) int32_t alignSelf;
@property(nonatomic, assign) CGFloat borderBottomWidth;
@property(nonatomic, strong, nullable) CALayer* bottomBorderLayer;
@end

@implementation NLTemplateBoxView

- (CGSize)nlMeasureForMaxWidth:(CGFloat)maxWidth exactWidth:(BOOL)exactWidth {
  CGFloat targetW = maxWidth;
  if (_fixedWidth > 0.0) {
    targetW = _fixedWidth;
  } else if (_maxWidthPercent > 0.0 && maxWidth > 0.0) {
    targetW = std::min(maxWidth, std::round(maxWidth * _maxWidthPercent));
  }
  const CGFloat innerW = std::max<CGFloat>(0.0, targetW - _padL - _padR);
  NSArray<UIView*>* subs = self.subviews;

  if (_isRow) {
    CGFloat usedW = 0.0;
    CGFloat maxH = 0.0;
    int visibleCount = 0;
    for (UIView* child in subs) {
      if (child.hidden || ![child conformsToProtocol:@protocol(NLTemplateLayoutNode)]) continue;
      id<NLTemplateLayoutNode> node = (id<NLTemplateLayoutNode>)child;
      if (visibleCount > 0) usedW += _gap;
      visibleCount++;
      const CGFloat remW = std::max<CGFloat>(0.0, innerW - usedW);
      BOOL childExact = NO;
      CGFloat childMax = remW;
      if ([child isKindOfClass:[NLTemplateImageView class]]) {
        NLTemplateImageView* iv = (NLTemplateImageView*)child;
        if (iv.fixedWidth > 0.0) {
          childMax = iv.fixedWidth;
          childExact = YES;
        }
      } else if ([child isKindOfClass:[NLTemplateBoxView class]]) {
        NLTemplateBoxView* box = (NLTemplateBoxView*)child;
        if (box.fixedWidth > 0.0) {
          childMax = box.fixedWidth;
          childExact = YES;
        }
      }
      const CGSize cs = [node nlMeasureForMaxWidth:childMax exactWidth:childExact];
      usedW += cs.width;
      const CGFloat ch = cs.height + node.nlMarginTop + node.nlMarginBottom;
      if (ch > maxH) maxH = ch;
    }
    const CGFloat finalW = _fixedWidth > 0.0
                               ? _fixedWidth
                               : (exactWidth && _maxWidthPercent <= 0.0
                                      ? maxWidth
                                      : std::min(targetW, _padL + usedW + _padR));
    const CGFloat finalH = _fixedHeight > 0.0 ? _fixedHeight : _padT + maxH + _padB;
    _nlMeasuredSize = CGSizeMake(finalW, finalH);
    return _nlMeasuredSize;
  } else {
    CGFloat totalH = 0.0;
    CGFloat maxChildW = 0.0;
    int visibleCount = 0;
    for (UIView* child in subs) {
      if (child.hidden || ![child conformsToProtocol:@protocol(NLTemplateLayoutNode)]) continue;
      id<NLTemplateLayoutNode> node = (id<NLTemplateLayoutNode>)child;
      if (visibleCount > 0) totalH += _gap;
      visibleCount++;
      totalH += node.nlMarginTop;

      CGFloat childMax = innerW;
      BOOL childExact = YES;
      if ([child isKindOfClass:[NLTemplateBoxView class]]) {
        NLTemplateBoxView* box = (NLTemplateBoxView*)child;
        if (box.fixedWidth > 0.0) {
          childMax = box.fixedWidth;
          childExact = YES;
        } else if (box.maxWidthPercent > 0.0) {
          childMax = std::min(innerW, std::round(innerW * box.maxWidthPercent));
          childExact = NO;
        } else {
          const int32_t selfAlign = box.alignSelf >= 0 ? box.alignSelf : _alignItems;
          childExact = (selfAlign == kAlignStretch);
        }
      } else if ([child isKindOfClass:[NLTemplateImageView class]]) {
        NLTemplateImageView* iv = (NLTemplateImageView*)child;
        childMax = iv.fixedWidth > 0.0 ? iv.fixedWidth : innerW;
        childExact = YES;
      } else {
        childExact = (_maxWidthPercent <= 0.0);
      }
      const CGSize cs = [node nlMeasureForMaxWidth:childMax exactWidth:childExact];
      if (cs.width > maxChildW) maxChildW = cs.width;
      totalH += cs.height + node.nlMarginBottom;
    }
    CGFloat finalW;
    if (_fixedWidth > 0.0) {
      finalW = _fixedWidth;
    } else if (_maxWidthPercent > 0.0) {
      finalW = std::min(targetW, _padL + maxChildW + _padR);
    } else if (exactWidth) {
      finalW = maxWidth;
    } else {
      finalW = _padL + maxChildW + _padR;
    }
    const CGFloat finalH = _fixedHeight > 0.0 ? _fixedHeight : _padT + totalH + _padB;
    _nlMeasuredSize = CGSizeMake(finalW, finalH);
    return _nlMeasuredSize;
  }
}

- (void)nlLayoutInRect:(CGRect)rect {
  self.frame = rect;
  if (_bottomBorderLayer != nil && _borderBottomWidth > 0.0) {
    _bottomBorderLayer.frame =
        CGRectMake(0.0, rect.size.height - _borderBottomWidth, rect.size.width, _borderBottomWidth);
  }
  const CGFloat innerW = std::max<CGFloat>(0.0, rect.size.width - _padL - _padR);
  const CGFloat innerH = std::max<CGFloat>(0.0, rect.size.height - _padT - _padB);
  NSArray<UIView*>* subs = self.subviews;

  if (_isRow) {
    CGFloat x = _padL;
    int visibleCount = 0;
    for (UIView* child in subs) {
      if (child.hidden || ![child conformsToProtocol:@protocol(NLTemplateLayoutNode)]) continue;
      id<NLTemplateLayoutNode> node = (id<NLTemplateLayoutNode>)child;
      if (visibleCount > 0) x += _gap;
      visibleCount++;
      const CGSize cs = node.nlMeasuredSize;
      CGFloat y;
      if (_alignItems == kAlignCenter) {
        y = _padT + (innerH - cs.height) * 0.5;
      } else if (_alignItems == kAlignEnd) {
        y = _padT + innerH - cs.height;
      } else {
        y = _padT + node.nlMarginTop;
      }
      [node nlLayoutInRect:CGRectMake(x, y, cs.width, cs.height)];
      x += cs.width;
    }
  } else {
    CGFloat y = _padT;
    int visibleCount = 0;
    for (UIView* child in subs) {
      if (child.hidden || ![child conformsToProtocol:@protocol(NLTemplateLayoutNode)]) continue;
      id<NLTemplateLayoutNode> node = (id<NLTemplateLayoutNode>)child;
      if (visibleCount > 0) y += _gap;
      visibleCount++;
      y += node.nlMarginTop;
      const CGSize cs = node.nlMeasuredSize;
      int32_t selfAlign = _alignItems;
      if ([child isKindOfClass:[NLTemplateBoxView class]]) {
        NLTemplateBoxView* box = (NLTemplateBoxView*)child;
        if (box.alignSelf >= 0) selfAlign = box.alignSelf;
      }
      CGFloat x;
      if (selfAlign == kAlignCenter) {
        x = _padL + (innerW - cs.width) * 0.5;
      } else if (selfAlign == kAlignEnd) {
        x = _padL + innerW - cs.width;
      } else {
        x = _padL;
      }
      [node nlLayoutInRect:CGRectMake(x, y, cs.width, cs.height)];
      y += cs.height + node.nlMarginBottom;
    }
  }
}

@end

// ---- Flat Per-Cell Bindings & Pool ----

namespace {

enum class BindingKind : uint8_t { Text, Image, Box, Visible };

struct NodeBinding {
  BindingKind kind;
  UIView* view = nil;
  int32_t fieldA = -1;
  int32_t fieldB = -1;
  CGFloat fallbackAspect = 0.0;
};

struct PooledCell {
  int32_t templateIdx = 0;
  UIView<NLTemplateLayoutNode>* root = nil;
  std::vector<NodeBinding> bindings;
  std::vector<NLTemplateTapTarget*> tapTargets;
  int32_t boundItemIndex = -1;
  int32_t boundChunkId = -1;
  int32_t boundGen = -1;
  double measuredSlotWidth = -1.0;
  double appliedTargetPt = NAN;
  int32_t appliedVisible = -1;
  int32_t currentPressItemIndex = -1;
};

} // namespace

@implementation NLNativeTemplateEngine {
  std::shared_ptr<TemplateSchema> _schema;
  DataStore _dataStore;
  NSInteger _containerViewTag;
  __weak UIView* _containerView;
  int32_t _numColumns;
  double _crossAxisGapPt;
  std::function<void(double, const std::string&)> _pressHandler;
  std::function<void(double, double)> _dataRequestHandler;
  std::unordered_map<int32_t, CFTimeInterval> _requestedChunkTimes;

  std::vector<std::shared_ptr<PooledCell>> _slotCells;
  std::unordered_map<int32_t, std::vector<std::shared_ptr<PooledCell>>> _freePools;
  int32_t _lastPrefetchStart;
  int32_t _lastPrefetchEnd;

  std::vector<double> _offsetsBuf;
  std::vector<int32_t> _infoBuf;
  std::vector<int32_t> _sizeIdsBuf;
  std::vector<double> _sizeValsBuf;
  std::vector<uint32_t> _sizeGensBuf;
}

- (instancetype)init {
  if ((self = [super init])) {
    _containerViewTag = -1;
    _numColumns = 1;
    _crossAxisGapPt = 0.0;
    _lastPrefetchStart = -1;
    _lastPrefetchEnd = -1;
    _offsetsBuf.resize(128, 0.0);
    _infoBuf.resize(128 * 6, 0);
  }
  return self;
}

- (BOOL)isActive {
  return _schema != nullptr && _containerViewTag > 0;
}

- (void)detachAllCells {
  for (auto& cell : _slotCells) {
    if (cell != nullptr) {
      [cell->root removeFromSuperview];
      cell.reset();
    }
  }
  _slotCells.clear();
  for (auto& kv : _freePools) {
    for (auto& cell : kv.second) {
      if (cell != nullptr) [cell->root removeFromSuperview];
    }
  }
}

- (void)setContainerTag:(NSInteger)tag
             numColumns:(int32_t)numColumns
         crossAxisGapPt:(double)crossAxisGapPt
               resolved:(nullable UIView*)resolved {
  if (_containerViewTag != tag) {
    [self detachAllCells];
    _containerViewTag = tag;
    _containerView = resolved;
  } else if (resolved != nil) {
    _containerView = resolved;
  }
  _numColumns = std::max(1, numColumns);
  _crossAxisGapPt = std::max(0.0, crossAxisGapPt);
}

- (void)setSchemaJson:(NSString*)schemaJson {
  [self detachAllCells];
  _freePools.clear();
  _requestedChunkTimes.clear();
  _lastPrefetchStart = -1;
  _lastPrefetchEnd = -1;
  _schema = parseTemplateSchema(schemaJson);
}

- (void)setDataChunkStart:(int32_t)startIndex
                    count:(int32_t)count
               totalCount:(int32_t)totalCount
                    reset:(BOOL)reset
                    bytes:(const uint8_t*)bytes
                   length:(size_t)length {
  if (reset) {
    _requestedChunkTimes.clear();
    _lastPrefetchStart = -1;
    _lastPrefetchEnd = -1;
  } else {
    const int32_t firstBucket = startIndex / 512;
    const int32_t lastBucket = (startIndex + count - 1) / 512;
    for (int32_t b = firstBucket; b <= lastBucket; ++b) {
      _requestedChunkTimes.erase(b);
    }
  }
  _dataStore.putChunk(startIndex, count, totalCount, reset ? true : false, bytes, length);
}

- (void)shiftDataIndicesDelta:(int32_t)delta totalCount:(int32_t)totalCount {
  if (delta == 0) return;
  _dataStore.shiftIndices(delta, totalCount);
  _requestedChunkTimes.clear();
  _lastPrefetchStart = -1;
  _lastPrefetchEnd = -1;
  const bool updatePrefix =
      _schema != nullptr && _schema->testIdFieldIdx < 0 && _schema->nativeIdFieldIdx < 0 &&
      _schema->nativeIdPrefix.length > 0;
  for (auto& cell : _slotCells) {
    if (cell == nullptr || cell->boundItemIndex < 0) continue;
    const int32_t shifted = cell->boundItemIndex + delta;
    if (shifted >= 0 && shifted < totalCount) {
      cell->boundItemIndex = shifted;
      cell->currentPressItemIndex = shifted;
      if (updatePrefix) {
        cell->root.accessibilityIdentifier =
            [NSString stringWithFormat:@"%@%d", _schema->nativeIdPrefix, shifted];
      }
    } else {
      cell->boundItemIndex = -1;
      cell->currentPressItemIndex = -1;
    }
  }
}

- (void)setPressHandler:(std::function<void(double, const std::string&)>)handler {
  _pressHandler = std::move(handler);
}

- (void)setDataRequestHandler:(std::function<void(double, double)>)handler {
  _dataRequestHandler = std::move(handler);
}

- (void)clear {
  [self detachAllCells];
  _freePools.clear();
  _dataStore.clear();
  _requestedChunkTimes.clear();
  _lastPrefetchStart = -1;
  _lastPrefetchEnd = -1;
  _schema.reset();
  _containerViewTag = -1;
  _containerView = nil;
  _pressHandler = nullptr;
  _dataRequestHandler = nullptr;
}

- (void)invalidateAppliedCoords {
  for (auto& cell : _slotCells) {
    if (cell != nullptr) cell->appliedTargetPt = NAN;
  }
}

- (UIView<NLTemplateLayoutNode>*)buildViewForSpec:(const NodeSpec&)spec
                                             cell:(PooledCell*)cell {
  UIView<NLTemplateLayoutNode>* view = nil;
  if (spec.type == "column" || spec.type == "row" || spec.type == "box") {
    NLTemplateBoxView* box = [[NLTemplateBoxView alloc] initWithFrame:CGRectZero];
    box.isRow = (spec.type == "row");
    box.gap = spec.gap;
    box.padL = spec.padL;
    box.padT = spec.padT;
    box.padR = spec.padR;
    box.padB = spec.padB;
    box.nlMarginTop = spec.marginTop;
    box.nlMarginBottom = spec.marginBottom;
    box.fixedWidth = spec.width;
    box.fixedHeight = spec.height;
    box.maxWidthPercent = spec.maxWidthPercent;
    box.alignItems = spec.alignItems;
    box.alignSelf = spec.alignSelf;
    box.borderBottomWidth = spec.borderBottomWidth;
    if (spec.hasBg) {
      box.backgroundColor = spec.bgColor;
    }
    if (spec.borderRadius > 0.0) {
      box.layer.cornerRadius = spec.borderRadius;
      box.clipsToBounds = YES;
    }
    if (spec.borderBottomWidth > 0.0) {
      CALayer* border = [CALayer layer];
      border.backgroundColor = spec.borderBottomColor.CGColor;
      [box.layer addSublayer:border];
      box.bottomBorderLayer = border;
    }
    if (spec.bgColorField >= 0 || spec.alignSelfField >= 0) {
      cell->bindings.push_back(
          NodeBinding{BindingKind::Box, box, spec.bgColorField, spec.alignSelfField, 0.0});
    }
    for (const auto& childSpec : spec.children) {
      UIView* childView = [self buildViewForSpec:childSpec cell:cell];
      [box addSubview:childView];
    }
    view = box;
  } else if (spec.type == "text") {
    NLTemplateLabel* lbl = [[NLTemplateLabel alloc] initWithFrame:CGRectZero];
    lbl.nlMarginTop = spec.marginTop;
    lbl.nlMarginBottom = spec.marginBottom;
    lbl.nlLineHeight = spec.lineHeight;
    lbl.font = [UIFont systemFontOfSize:spec.fontSize > 0.0 ? spec.fontSize : 14.0
                                 weight:fontWeightFromInt(spec.fontWeight)];
    lbl.textColor = spec.textColor != nil ? spec.textColor : UIColor.blackColor;
    lbl.numberOfLines = spec.maxLines > 0 ? spec.maxLines : 0;
    if (spec.staticText != nil) {
      [lbl nlSetTextString:spec.staticText];
    }
    if (spec.textField >= 0 || spec.textColorField >= 0) {
      cell->bindings.push_back(
          NodeBinding{BindingKind::Text, lbl, spec.textField, spec.textColorField, 0.0});
    }
    view = lbl;
  } else if (spec.type == "image") {
    NLTemplateImageView* iv = [[NLTemplateImageView alloc] initWithFrame:CGRectZero];
    iv.nlMarginTop = spec.marginTop;
    iv.nlMarginBottom = spec.marginBottom;
    iv.fixedWidth = spec.width;
    iv.fixedHeight = spec.height;
    iv.dynamicAspectRatio = spec.aspectRatio;
    if (spec.resizeMode == 1) iv.contentMode = UIViewContentModeScaleAspectFit;
    else if (spec.resizeMode == 2) iv.contentMode = UIViewContentModeScaleToFill;
    else iv.contentMode = UIViewContentModeScaleAspectFill;
    if (spec.hasBg) iv.backgroundColor = spec.bgColor;
    if (spec.borderRadius > 0.0) {
      iv.layer.cornerRadius = spec.borderRadius;
      iv.clipsToBounds = YES;
    }
    if (spec.staticUri != nil && spec.staticUri.length > 0) {
      [iv nlLoadUri:spec.staticUri];
    }
    if (spec.uriField >= 0 || spec.aspectRatioField >= 0) {
      cell->bindings.push_back(NodeBinding{
          BindingKind::Image, iv, spec.uriField, spec.aspectRatioField, spec.aspectRatio});
    }
    view = iv;
  } else {
    NLTemplateBoxView* fallback = [[NLTemplateBoxView alloc] initWithFrame:CGRectZero];
    view = fallback;
  }

  if (spec.visibleField >= 0) {
    cell->bindings.push_back(NodeBinding{BindingKind::Visible, view, spec.visibleField, -1, 0.0});
  }
  if (!spec.pressAction.empty()) {
    view.userInteractionEnabled = YES;
    NLTemplateTapTarget* target = [[NLTemplateTapTarget alloc] init];
    target.itemIndexPtr = &cell->currentPressItemIndex;
    target.handlerPtr = &_pressHandler;
    target.actionName = [NSString stringWithUTF8String:spec.pressAction.c_str()];
    UITapGestureRecognizer* tap =
        [[UITapGestureRecognizer alloc] initWithTarget:target action:@selector(handleTap:)];
    [view addGestureRecognizer:tap];
    cell->tapTargets.push_back(target);
  }
  return view;
}

- (std::shared_ptr<PooledCell>)inflateCellForTemplate:(int32_t)tmplIdx
                                             rootSpec:(const NodeSpec&)rootSpec {
  auto cell = std::make_shared<PooledCell>();
  cell->templateIdx = tmplIdx;
  cell->root = [self buildViewForSpec:rootSpec cell:cell.get()];
  return cell;
}

- (void)bindCell:(PooledCell*)cell
       itemIndex:(int32_t)itemIndex
        localIdx:(int32_t)localIdx
           chunk:(DataChunk*)chunk
          schema:(const TemplateSchema&)schema {
  cell->currentPressItemIndex = itemIndex;

  NSString* ident = nil;
  if (schema.testIdFieldIdx >= 0) {
    ident = chunk->getString(localIdx, schema.testIdFieldIdx);
  } else if (schema.nativeIdFieldIdx >= 0) {
    ident = chunk->getString(localIdx, schema.nativeIdFieldIdx);
  } else if (schema.nativeIdPrefix.length > 0) {
    ident = [NSString stringWithFormat:@"%@%d", schema.nativeIdPrefix, itemIndex];
  }
  if (ident != nil) {
    cell->root.accessibilityIdentifier = ident;
  }

  for (const auto& b : cell->bindings) {
    switch (b.kind) {
      case BindingKind::Visible: {
        const float v = chunk->getNumber(localIdx, b.fieldA);
        const BOOL hide = std::isnan(v) || v == 0.0f;
        if (b.view.hidden != hide) b.view.hidden = hide;
        break;
      }
      case BindingKind::Text: {
        NLTemplateLabel* lbl = (NLTemplateLabel*)b.view;
        if (b.fieldB >= 0) {
          const int32_t cOff = chunk->getStringOffset(localIdx, b.fieldB);
          if (cOff >= 0 && (lbl.boundChunkId != chunk->chunkId || lbl.boundColorOffset != cOff)) {
            UIColor* col = chunk->getColor(localIdx, b.fieldB);
            if (col != nil) lbl.textColor = col;
            lbl.boundColorOffset = cOff;
          }
        }
        if (b.fieldA >= 0) {
          const int32_t off = chunk->getStringOffset(localIdx, b.fieldA);
          const int32_t len = chunk->getStringLength(localIdx, b.fieldA);
          if (len > 160 || lbl.boundChunkId != chunk->chunkId || lbl.boundTextOffset != off) {
            NSString* txt = chunk->getString(localIdx, b.fieldA);
            [lbl nlSetTextString:txt != nil ? txt : @""];
            lbl.boundChunkId = chunk->chunkId;
            lbl.boundTextOffset = len <= 160 ? off : -2;
          }
        }
        break;
      }
      case BindingKind::Image: {
        NLTemplateImageView* iv = (NLTemplateImageView*)b.view;
        if (b.fieldB >= 0) {
          const float ar = chunk->getNumber(localIdx, b.fieldB);
          iv.dynamicAspectRatio = (!std::isnan(ar) && ar > 0.0f) ? ar : b.fallbackAspect;
        }
        if (b.fieldA >= 0) {
          const int32_t off = chunk->getStringOffset(localIdx, b.fieldA);
          if (off < 0) {
            if (iv.boundUriOffset != -1) {
              [iv nlLoadUri:nil];
              iv.boundUriOffset = -1;
            }
          } else if (iv.boundChunkId != chunk->chunkId || iv.boundUriOffset != off) {
            NSString* uri = chunk->getString(localIdx, b.fieldA);
            [iv nlLoadUri:uri];
            iv.boundChunkId = chunk->chunkId;
            iv.boundUriOffset = off;
          }
        }
        break;
      }
      case BindingKind::Box: {
        NLTemplateBoxView* box = (NLTemplateBoxView*)b.view;
        if (b.fieldA >= 0) {
          UIColor* bg = chunk->getColor(localIdx, b.fieldA);
          if (bg != nil) box.backgroundColor = bg;
        }
        if (b.fieldB >= 0) {
          const int32_t align = chunk->getAlign(localIdx, b.fieldB);
          if (align >= 0) box.alignSelf = align;
        }
        break;
      }
    }
  }
}

- (void)requestMissingChunkMin:(int32_t)minIdx max:(int32_t)maxIdx {
  if (!_dataRequestHandler || _dataStore.totalCount <= 0) return;
  const int32_t total = _dataStore.totalCount;
  const int32_t cMin = std::max(0, std::min(total - 1, minIdx));
  const int32_t cMax = std::max(cMin, std::min(total - 1, maxIdx));
  const int32_t bucket = cMin / 512;
  const CFTimeInterval now = CACurrentMediaTime();
  auto it = _requestedChunkTimes.find(bucket);
  if (it != _requestedChunkTimes.end() && (now - it->second) < 1.0) return;
  _requestedChunkTimes[bucket] = now;
  const int32_t reqStart = bucket * 512;
  const int32_t reqEnd = std::min(total, std::max(reqStart + 1024, ((cMax / 512) + 1) * 512));
  const int32_t reqCount = reqEnd - reqStart;
  if (reqCount > 0) {
    _dataRequestHandler(static_cast<double>(reqStart), static_cast<double>(reqCount));
  }
}

- (void)prefetchLookaheadWithSchema:(const TemplateSchema&)schema
                          minActive:(int32_t)minActive
                          maxActive:(int32_t)maxActive {
  const int32_t lookBehind = _numColumns > 1 ? _numColumns * 3 : 4;
  const int32_t lookAhead = _numColumns > 1 ? _numColumns * 5 : 8;
  const int32_t start = std::max(0, minActive - lookBehind);
  const int32_t end = std::min(_dataStore.totalCount - 1, maxActive + lookAhead);
  if (start == _lastPrefetchStart && end == _lastPrefetchEnd) return;
  const int32_t prevStart = _lastPrefetchStart;
  const int32_t prevEnd = _lastPrefetchEnd;
  _lastPrefetchStart = start;
  _lastPrefetchEnd = end;
  for (int32_t idx = start; idx <= end; ++idx) {
    if (idx >= prevStart && idx <= prevEnd) continue;
    DataChunk* chunk = _dataStore.findChunk(idx);
    if (chunk == nullptr) continue;
    const int32_t local = idx - chunk->startIndex;
    for (int32_t f : schema.imageFieldIndices) {
      const int32_t off = chunk->getStringOffset(local, f);
      if (off < 0 || !chunk->prefetchedOffsets.insert(off).second) continue;
      NSString* uri = chunk->getString(local, f);
      if (uri != nil && uri.length > 0 && [sharedTemplateImageCache() objectForKey:uri] == nil) {
        fetchTemplateImage(uri, nil);
      }
    }
  }
}

- (NLTemplateSyncResult)
    syncAndPositionWithEngine:(const std::shared_ptr<EngineCoreState>&)state
                   scrollView:(UIScrollView*)sv
             resolveContainer:(UIView* (^)(NSInteger))resolveContainer
                   horizontal:(BOOL)horizontal
                  mvcpEnabled:(BOOL)mvcpEnabled
                   inMomentum:(BOOL)inMomentum
          suppressDataRequest:(BOOL)suppressDataRequest
            mvcpMomentumShift:(double)mvcpMomentumShift
             onApplyMvcpDelta:(double (^)(double))onApplyMvcpDelta
           onDrainedMvcpShift:(double (^)(double))onDrainedMvcpShift {
  (void)inMomentum;
  NLTemplateSyncResult empty;
  if (_schema == nullptr || state == nullptr) return empty;

  UIView* parent = _containerView;
  if (parent == nil || parent.window == nil) {
    parent = resolveContainer(_containerViewTag);
    _containerView = parent;
  }
  if (parent == nil) return empty;

  const double svW = sv.bounds.size.width;
  const double svH = sv.bounds.size.height;
  if (svW <= 0.0 || svH <= 0.0) return empty;
  const double parentW = parent.bounds.size.width > 0.0 ? parent.bounds.size.width : svW;

  double totalSizeDp = 0.0;
  int32_t stickyIndex = -1;
  double stickyTransDp = 0.0;
  double pendingMvcp = 0.0;

  int32_t slotCount = state->readTemplateSlots(
      _offsetsBuf.data(), _infoBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
      totalSizeDp, stickyIndex, stickyTransDp, &pendingMvcp);
  if (slotCount > static_cast<int32_t>(_offsetsBuf.size())) {
    const size_t nextCap = static_cast<size_t>(slotCount) + 16;
    _offsetsBuf.resize(nextCap, 0.0);
    _infoBuf.resize(nextCap * 6, 0);
    double extraMvcp = 0.0;
    slotCount = state->readTemplateSlots(
        _offsetsBuf.data(), _infoBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
        totalSizeDp, stickyIndex, stickyTransDp, &extraMvcp);
    pendingMvcp += extraMvcp;
  }
  double currentMomentumShift = onDrainedMvcpShift(pendingMvcp);
  if (slotCount <= 0) return empty;
  if (_slotCells.size() < static_cast<size_t>(slotCount)) {
    _slotCells.resize(static_cast<size_t>(slotCount));
  }

  _sizeIdsBuf.clear();
  _sizeValsBuf.clear();
  _sizeGensBuf.clear();

  int32_t minActiveItem = INT32_MAX;
  int32_t maxActiveItem = -1;
  int32_t missingMin = INT32_MAX;
  int32_t missingMax = -1;

  for (int32_t s = 0; s < slotCount; ++s) {
    const size_t base = static_cast<size_t>(s) * 6;
    const bool active = _infoBuf[base + 0] != 0;
    const int32_t itemIndex = _infoBuf[base + 1];
    const int32_t expectedGen = _infoBuf[base + 2];
    const int32_t col = _infoBuf[base + 3];
    const int32_t span = _infoBuf[base + 4];
    const bool measures = _infoBuf[base + 5] != 0;

    if (!active || itemIndex < 0) {
      auto& existing = _slotCells[static_cast<size_t>(s)];
      if (existing != nullptr && existing->appliedVisible != 0) {
        existing->root.hidden = YES;
        existing->appliedVisible = 0;
      }
      continue;
    }
    if (itemIndex < minActiveItem) minActiveItem = itemIndex;
    if (itemIndex > maxActiveItem) maxActiveItem = itemIndex;

    DataChunk* chunk = _dataStore.findChunk(itemIndex);
    if (chunk == nullptr) {
      auto& existing = _slotCells[static_cast<size_t>(s)];
      if (existing != nullptr && existing->appliedVisible != 0) {
        existing->root.hidden = YES;
        existing->appliedVisible = 0;
      }
      if (itemIndex < missingMin) missingMin = itemIndex;
      if (itemIndex > missingMax) missingMax = itemIndex;
      continue;
    }

    const int32_t localIdx = itemIndex - chunk->startIndex;
    const int32_t maxTmpl = static_cast<int32_t>(_schema->roots.size()) - 1;
    const int32_t tmplIdx = std::max(0, std::min(maxTmpl, chunk->templateIndex(localIdx)));

    auto& cell = _slotCells[static_cast<size_t>(s)];
    if (cell == nullptr || cell->templateIdx != tmplIdx) {
      if (cell != nullptr) {
        cell->root.hidden = YES;
        cell->appliedVisible = 0;
        _freePools[cell->templateIdx].push_back(cell);
      }
      auto& pool = _freePools[tmplIdx];
      if (!pool.empty()) {
        cell = pool.back();
        pool.pop_back();
      } else {
        cell = [self inflateCellForTemplate:tmplIdx rootSpec:_schema->roots[static_cast<size_t>(tmplIdx)]];
        [parent addSubview:cell->root];
      }
      cell->boundGen = -1;
      cell->boundItemIndex = -1;
      cell->appliedTargetPt = NAN;
    }

    double slotWidth = parentW;
    double slotLeft = 0.0;
    if (_numColumns > 1) {
      const double colW = parentW / static_cast<double>(_numColumns);
      slotWidth = std::max(1.0, std::round(colW * span) - _crossAxisGapPt);
      slotLeft = std::round(colW * col) + _crossAxisGapPt * 0.5;
    }

    const bool needsRebind = cell->boundItemIndex != itemIndex || cell->boundChunkId != chunk->chunkId;
    const bool needsRemeasure = needsRebind || cell->boundGen != expectedGen ||
                                std::abs(cell->measuredSlotWidth - slotWidth) > 0.25;

    if (needsRebind) {
      [self bindCell:cell.get() itemIndex:itemIndex localIdx:localIdx chunk:chunk schema:*_schema];
      cell->boundItemIndex = itemIndex;
      cell->boundChunkId = chunk->chunkId;
    }
    if (needsRemeasure) {
      cell->boundGen = expectedGen;
      cell->measuredSlotWidth = slotWidth;
      const CGSize measured = [cell->root nlMeasureForMaxWidth:slotWidth exactWidth:YES];
      cell->root.transform = CGAffineTransformIdentity;
      [cell->root nlLayoutInRect:CGRectMake(slotLeft, 0.0, measured.width, measured.height)];
      cell->appliedTargetPt = NAN;
      const double sizePt = horizontal ? measured.width : measured.height;
      if (measures && sizePt > 0.0) {
        _sizeIdsBuf.push_back(s);
        _sizeValsBuf.push_back(sizePt);
        _sizeGensBuf.push_back(static_cast<uint32_t>(expectedGen));
      }
    }
  }

  bool layoutChanged = false;
  int32_t layoutVersion = -1;
  if (!_sizeIdsBuf.empty()) {
    const auto szRes = state->onNativeSlotSizes(
        _sizeIdsBuf.data(), _sizeValsBuf.data(), _sizeGensBuf.data(),
        static_cast<int32_t>(_sizeIdsBuf.size()), mvcpEnabled ? true : false);
    if (szRes.changed) {
      layoutChanged = true;
      totalSizeDp = szRes.totalSizeDp;
      layoutVersion = szRes.layoutVersion;
      if (mvcpEnabled && std::abs(szRes.mvcpDeltaDp) > 0.1) {
        currentMomentumShift = onApplyMvcpDelta(szRes.mvcpDeltaDp);
      }
      double extraMvcp = 0.0;
      slotCount = state->readTemplateSlots(
          _offsetsBuf.data(), _infoBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
          totalSizeDp, stickyIndex, stickyTransDp, &extraMvcp);
      if (slotCount > static_cast<int32_t>(_offsetsBuf.size())) {
        const size_t nextCap = static_cast<size_t>(slotCount) + 16;
        _offsetsBuf.resize(nextCap, 0.0);
        _infoBuf.resize(nextCap * 6, 0);
        double retryMvcp = 0.0;
        slotCount = state->readTemplateSlots(
            _offsetsBuf.data(), _infoBuf.data(), static_cast<int32_t>(_offsetsBuf.size()),
            totalSizeDp, stickyIndex, stickyTransDp, &retryMvcp);
        extraMvcp += retryMvcp;
      }
      if (_slotCells.size() < static_cast<size_t>(slotCount)) {
        _slotCells.resize(static_cast<size_t>(slotCount));
      }
      currentMomentumShift = onDrainedMvcpShift(extraMvcp);
    }
  }

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (int32_t s = 0; s < slotCount; ++s) {
    const size_t base = static_cast<size_t>(s) * 6;
    const bool active = _infoBuf[base + 0] != 0;
    const int32_t itemIndex = _infoBuf[base + 1];
    auto& cell = _slotCells[static_cast<size_t>(s)];
    if (cell == nullptr) continue;
    if (!active || itemIndex < 0 || cell->boundItemIndex != itemIndex) {
      if (cell->appliedVisible != 0) {
        cell->root.hidden = YES;
        cell->appliedVisible = 0;
      }
      continue;
    }
    const double targetPt = _offsetsBuf[static_cast<size_t>(s)] - currentMomentumShift;
    if (std::isnan(cell->appliedTargetPt) || std::abs(cell->appliedTargetPt - targetPt) > 0.05) {
      cell->root.transform = horizontal ? CGAffineTransformMakeTranslation(targetPt, 0.0)
                                        : CGAffineTransformMakeTranslation(0.0, targetPt);
      cell->appliedTargetPt = targetPt;
    }
    if (cell->appliedVisible != 1) {
      cell->root.hidden = NO;
      cell->appliedVisible = 1;
    }
  }
  [CATransaction commit];

  if (!suppressDataRequest && _dataStore.totalCount > 0 && _dataRequestHandler) {
    if (missingMin <= missingMax) {
      [self requestMissingChunkMin:missingMin max:missingMax];
    } else if (maxActiveItem >= minActiveItem && _dataStore.totalCount > 4096) {
      const int32_t ahead = std::min(_dataStore.totalCount - 1, maxActiveItem + 96);
      const int32_t behind = std::max(0, minActiveItem - 96);
      if (_dataStore.findChunk(ahead) == nullptr) {
        [self requestMissingChunkMin:ahead max:ahead];
      } else if (_dataStore.findChunk(behind) == nullptr) {
        [self requestMissingChunkMin:behind max:behind];
      }
    }
  }

  if (!_schema->imageFieldIndices.empty() && maxActiveItem >= minActiveItem) {
    [self prefetchLookaheadWithSchema:*_schema minActive:minActiveItem maxActive:maxActiveItem];
  }

  return NLTemplateSyncResult{
      slotCount, layoutChanged, totalSizeDp, layoutVersion, stickyIndex, stickyTransDp};
}

@end
