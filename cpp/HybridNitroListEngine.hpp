#pragma once

#include "HybridNitroListEngineSpec.hpp"
#include "LayoutCore.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>

namespace margelo::nitro::nitrolist {

class HybridNitroListEngine : public HybridNitroListEngineSpec {
public:
  using RangeCallback = std::function<void(double, double, double, double)>;

  HybridNitroListEngine();
  ~HybridNitroListEngine() override = default;

  std::optional<RangeCallback> getOnRangeChange() override;
  void setOnRangeChange(const std::optional<RangeCallback>& onRangeChange) override;

  void configure(double itemCount, double estimatedItemSize, double drawDistance, bool horizontal,
                 double numColumns, double measurementEpsilon) override;
  void setScrollOffset(double offset) override;
  double setScrollOffsetAndFill(double offset, const std::shared_ptr<ArrayBuffer>& slab) override;
  void resetScrollVelocity() override;
  void setEstimatesFrozen(bool frozen) override;
  void setViewport(double width, double height) override;
  void setItemSize(double index, double size) override;
  void setItemSizesBatch(const std::shared_ptr<ArrayBuffer>& pairs, bool emitRange) override;
  double setItemSizesBatchAnchored(const std::shared_ptr<ArrayBuffer>& pairs, double anchorIndex,
                                   bool emitRange) override;
  void resetItemSizes() override;
  void remapItemSizes(const std::shared_ptr<ArrayBuffer>& pairs) override;
  bool setItemTypes(const std::shared_ptr<ArrayBuffer>& types) override;
  bool setItemTypesRange(double start, const std::shared_ptr<ArrayBuffer>& types) override;
  void setItemSpans(const std::shared_ptr<ArrayBuffer>& spans) override;
  void seedTypeMeans(const std::shared_ptr<ArrayBuffer>& pairs) override;
  double fillLayoutSlab(const std::shared_ptr<ArrayBuffer>& slab) override;
  double fillTypeStats(const std::shared_ptr<ArrayBuffer>& out) override;
  double countUnmeasured(double from, double to) override;
  double getItemOffset(double index) override;
  double getItemSize(double index) override;
  double getTotalSize() override;

  size_t getExternalMemorySize() noexcept override;

private:
  double mainViewportLocked() const;
  void maybeEmitRange();

  LayoutCore core_;
  std::mutex stateMutex_;
  double scrollOffset_ = 0.0;
  double viewportWidth_ = 0.0;
  double viewportHeight_ = 0.0;
  double drawDistance_ = 0.0;
  bool horizontal_ = false;
  int32_t lastStart_ = -1;
  int32_t lastEnd_ = -2;
  int32_t lastVersion_ = -1;
  std::optional<RangeCallback> onRangeChange_;
};

}
