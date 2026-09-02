#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

namespace margelo::nitro::nitrolist {

class LayoutCore {
public:
  struct EngagedRange {
    int32_t start;
    int32_t end;
    int32_t version;
  };

  bool setItemCount(int32_t count);

  bool setEstimate(double value);

  void setMeasurementEpsilon(double value);

  bool setItemSize(int32_t index, double size);

  bool setItemSizes(const double* pairs, int32_t pairCount, double scale);

  double setItemSizesAnchored(const double* pairs, int32_t pairCount, double scale,
                              int32_t anchorIndex);

  bool resetItemSizes();

  bool remapItemSizes(const double* pairs, int32_t pairCount);

  void resetAll();

  size_t getMemoryFootprint();

  bool setItemTypes(const uint16_t* types, int32_t count);

  bool setItemTypesRange(int32_t start, const uint16_t* types, int32_t count);

  int32_t countUnmeasured(int32_t from, int32_t to);

  void setTypeAverages(bool enabled);

  bool seedTypeMeans(const double* pairs, int32_t pairCount, double scale);

  int32_t fillLayoutSlab(double* out, int32_t capacityDoubles, double scrollOffset,
                         double viewportHeight, double drawDistance, double outputScale);

  void setColumnCount(int32_t columns);

  bool setItemSpans(const uint16_t* spans, int32_t count);

  int32_t fillTypeStats(double* out, int32_t capacityDoubles, double outputScale);

  double getTotalSize();
  double getOffset(int32_t index);
  double getSize(int32_t index);
  int32_t getLayoutVersion();

  void setDirectionalBuffers(bool enabled);

  bool setEstimatesFrozen(bool frozen);

  void resetScrollVelocity();

  using ClockFn = double (*)();
  void setClockForTesting(ClockFn clock);

  EngagedRange getEngagedRange(double scrollOffset, double viewportHeight, double drawDistance);

private:
  struct TypeStats {
    double mean = 0.0;
    double appliedMean = 0.0;
    int32_t num = 0;
    bool seeded = false;
  };

  void ensureClean();

  EngagedRange computeEngagedRangeLocked(double scrollOffset, double viewportHeight,
                                         double drawDistance);

  bool applyItemSizesLocked(const double* pairs, int32_t pairCount, double scale);

  void updateTypeMeanLocked(int32_t index, bool wasMeasured, float prevSize, float newSize);

  bool applyTypeMeansLocked();

  bool assignTypesLocked(int32_t start, const uint16_t* types, int32_t count);

  float estimateForTypeLocked(uint16_t type) const;

  static float roundToOctave(double value);

  std::mutex mutex_;

  int32_t spanAtLocked(int32_t index) const;

  std::vector<float> sizes_;
  std::vector<double> offsets_;
  std::vector<uint8_t> measured_;
  std::vector<uint16_t> types_;
  std::vector<uint16_t> spans_;

  int32_t columnCount_ = 1;
  std::vector<int32_t> rowStart_;

  bool typeAverages_ = false;
  bool estimatesFrozen_ = false;
  std::vector<TypeStats> typeStats_;

  int32_t itemCount_ = 0;
  float estimate_ = 0.0f;
  double totalSize_ = 0.0;
  double measurementEpsilon_ = 0.0;

  int32_t minDirtyIndex_ = INT32_MAX;

  int32_t layoutVersion_ = 0;

  bool hasRangeWindow_ = false;
  double rangeWindowMin_ = 0.0;
  double rangeWindowMax_ = 0.0;
  double rangeWindowViewport_ = -1.0;
  double rangeWindowDraw_ = -1.0;
  int32_t cachedStart_ = 0;
  int32_t cachedEnd_ = -1;
  int32_t cachedVersion_ = -1;
  int32_t cachedRegime_ = 0;

  bool directionalBuffers_ = false;
  ClockFn clock_ = nullptr;
  double lastSampleTimeMs_ = -1.0;
  double lastSampleOffset_ = 0.0;
  double velocity_ = 0.0;
  int32_t regime_ = 0;
  int32_t pendingRegime_ = 0;
  int32_t pendingRegimeCount_ = 0;
};

}
