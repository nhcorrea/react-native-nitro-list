#pragma once

#include "EngineRegistry.hpp"
#include "HybridNitroListEngineSpec.hpp"
#include "LayoutCore.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

namespace margelo::nitro::nitrolist {

class HybridNitroListEngine : public HybridNitroListEngineSpec {
public:
  using RangeCallback = std::function<void(double, double, double, double)>;

  HybridNitroListEngine();
  ~HybridNitroListEngine() override;

  std::optional<RangeCallback> getOnRangeChange() override;
  void setOnRangeChange(const std::optional<RangeCallback>& onRangeChange) override;

  void configure(double itemCount, double estimatedItemSize, double drawDistance, bool horizontal,
                 double numColumns, double measurementEpsilon) override;
  void setScrollOffset(double offset) override;
  void updateData(const std::shared_ptr<ArrayBuffer>& config,
                  const std::shared_ptr<ArrayBuffer>& types,
                  const std::shared_ptr<ArrayBuffer>& spans,
                  const std::shared_ptr<ArrayBuffer>& fixedSizes,
                  const std::shared_ptr<ArrayBuffer>& remap) override;
  double setScrollOffsetAndFill(double offset, const std::shared_ptr<ArrayBuffer>& slab) override;
  double setItemSizesAndFill(const std::shared_ptr<ArrayBuffer>& pairs, double pairCount,
    double anchorIndex, double dataRevision, const std::shared_ptr<ArrayBuffer>& slab) override;
  double readSnapshot(double sequence, const std::shared_ptr<ArrayBuffer>& slab) override;
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
  double readLayout(double start, double count, const std::shared_ptr<ArrayBuffer>& out) override;

  double getEngineId() override;
  void configureSlots(double maxParked, double mainAxisGap, double paddingStart) override;
  void setStickyConfig(const std::shared_ptr<ArrayBuffer>& indices, double stickyOffset,
                       double stickySize) override;
  void setMvcpConfig(bool enabled, double anchorIndex) override;
  double reconcileSlots(const std::shared_ptr<ArrayBuffer>& extraIndices, double budgetSlots,
                        const std::shared_ptr<ArrayBuffer>& outDeltas) override;

  size_t getExternalMemorySize() noexcept override;
  void dispose() override;

private:
  void maybeEmitRange();
  double fillSnapshotLocked(double* out, int32_t capacity, double anchorDelta = 0.0,
                            bool allowSkipBody = false);
  void mirrorTypesLocked(int32_t start, const uint16_t* types, int32_t count, bool replaceAll);

  std::shared_ptr<EngineCoreState> state_;
  int64_t engineId_ = 0;
  double sequence_ = 0;
  std::vector<double> pendingSnapshot_;
  std::optional<RangeCallback> onRangeChange_;
};

} // namespace margelo::nitro::nitrolist
