#pragma once

#include "HybridNitroListNativeHostSpec.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::nitrolist {

class HybridNitroListNativeHost : public HybridNitroListNativeHostSpec {
public:
  HybridNitroListNativeHost();
  ~HybridNitroListNativeHost() override;

  double attachHost(
      double engineId,
      double scrollViewTag,
      double stickyViewTag,
      bool horizontal,
      bool userHasOnScroll,
      const std::function<void(double, double, double, double, double, double, double,
                               const std::shared_ptr<ArrayBuffer>&)>& onSlotRebinds,
      const std::function<void(double, double)>& onContentSize) override;

  void detachHost(double hostId) override;
  void registerSlotView(double hostId, double slotId, double viewTag, bool measures) override;
  void unregisterSlotView(double hostId, double slotId) override;
  void setSlotMeasures(double hostId, double slotId, bool measures) override;
  void setStickyViewTag(double hostId, double stickyViewTag) override;
  void setUserHasOnScroll(double hostId, bool hasOnScroll) override;
  void setMvcpEnabled(double hostId, bool enabled) override;
  void applyMvcpShift(double hostId, double deltaDp) override;
  void notifyDataCommit(double hostId, double paddingStartDp, double mainAxisGapDp) override;
  void syncNow(double hostId) override;

  void prefetchImages(const std::vector<std::string>& uris, double widthPx,
                      double heightPx) override;
  void cancelImagePrefetch() override;

  void attachNativeSlotContainer(double hostId, double containerViewTag, double numColumns,
                                 double crossAxisGapDp) override;
  void setNativeTemplateSchema(double hostId, const std::string& schemaJson) override;
  void setNativeTemplateData(double hostId, double startIndex, double count, double totalCount,
                             bool reset,
                             const std::shared_ptr<ArrayBuffer>& packedData) override;
  void shiftNativeTemplateData(double hostId, double delta, double totalCount) override;
  void setNativePressHandler(
      double hostId, const std::function<void(double, const std::string&)>& onPress) override;
  void setNativeDataRequestHandler(
      double hostId, const std::function<void(double, double)>& onRequestData) override;
  void clearNativeTemplate(double hostId) override;
};

} // namespace margelo::nitro::nitrolist
