#pragma once

#include <cstdint>
#include <functional>
#include <unordered_map>
#include <vector>

namespace margelo::nitro::nitrolist {

struct SlotRecord {
  int32_t itemIndex = -1;
  int32_t lastItemIndex = -1;
  uint16_t itemType = 0;
  uint32_t generation = 0;
  uint32_t committedGen = 0;
  int32_t viewTag = 0;
  double measuredSize = -1.0;
  bool active = false;
  bool parked = false;
  bool measures = true;
  bool invalidated = false;
};

struct SlotDelta {
  static constexpr uint8_t kFlagActive = 1 << 0;
  static constexpr uint8_t kFlagCreated = 1 << 1;
  static constexpr uint8_t kFlagItemChanged = 1 << 2;

  int32_t slotId = 0;
  int32_t itemIndex = -1;
  uint32_t generation = 0;
  uint8_t flags = 0;
};

class SlotPool {
public:
  void configure(int32_t maxParked);
  void reset();
  void clearAll();

  void invalidateRange(int32_t start, int32_t end);
  void remapIndices(const double* pairs, int32_t pairCount, int32_t newItemCount);

  void setSlotViewTag(int32_t slotId, int32_t viewTag, bool measures);
  void unregisterSlotView(int32_t slotId);
  void setSlotMeasures(int32_t slotId, bool measures);
  void markSlotCommitted(int32_t slotId, uint32_t generation);

  // Reconciles the pool against [rangeStart..rangeEnd] union extraIndices.
  // If budgetSlots > 0, caps newly assigned slots per frame to budgetSlots,
  // prioritizing items closest to focusIndex, and sets hasMorePending() = true.
  // Returns number of deltas written to outDeltas.
  int32_t reconcile(int32_t itemCount,
                    int32_t rangeStart,
                    int32_t rangeEnd,
                    const int32_t* extraIndices,
                    int32_t extraCount,
                    const std::function<uint16_t(int32_t)>& typeOf,
                    int32_t budgetSlots,
                    int32_t focusIndex,
                    std::vector<SlotDelta>& outDeltas);

  int32_t slotCount() const { return static_cast<int32_t>(slots_.size()); }
  const std::vector<SlotRecord>& slots() const { return slots_; }
  std::vector<SlotRecord>& slotsMut() { return slots_; }
  bool hasMorePending() const { return hasMorePending_; }
  size_t getMemoryFootprint() const;

private:
  int32_t distanceToRange(int32_t index, int32_t low, int32_t high) const;
  int32_t pickBestFreeSlot(const std::vector<int32_t>& freeSlots,
                           int32_t wantIndex,
                           uint16_t wantType,
                           int32_t rangeLow,
                           int32_t rangeHigh,
                           bool& outAffinityReused);

  std::vector<SlotRecord> slots_;
  std::unordered_map<int32_t, int32_t> activeByIndex_;
  std::vector<int32_t> scratchDesired_;
  std::vector<int32_t> scratchPending_;
  std::vector<int32_t> scratchFree_;
  std::vector<uint8_t> scratchDesiredFlag_;
  int32_t maxParked_ = 12;
  uint32_t nextGen_ = 1;
  bool hasMorePending_ = false;
};

} // namespace margelo::nitro::nitrolist
