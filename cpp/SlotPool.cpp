#include "SlotPool.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace margelo::nitro::nitrolist {

void SlotPool::configure(int32_t maxParked) {
  maxParked_ = std::max(0, maxParked);
}

void SlotPool::reset() {
  activeByIndex_.clear();
  for (auto& slot : slots_) {
    slot.itemIndex = -1;
    slot.lastItemIndex = -1;
    slot.active = false;
    slot.parked = false;
    slot.measuredSize = -1.0;
    slot.invalidated = true;
    slot.inPlaceUpdate = false;
    slot.generation = nextGen_++;
  }
  hasMorePending_ = false;
}

void SlotPool::clearAll() {
  std::vector<SlotRecord>().swap(slots_);
  std::unordered_map<int32_t, int32_t>().swap(activeByIndex_);
  std::vector<int32_t>().swap(scratchDesired_);
  std::vector<int32_t>().swap(scratchPending_);
  std::vector<int32_t>().swap(scratchFree_);
  std::vector<uint8_t>().swap(scratchDesiredFlag_);
  nextGen_ = 1;
  hasMorePending_ = false;
}

void SlotPool::invalidateRange(int32_t start, int32_t end) {
  for (auto& slot : slots_) {
    const int32_t idx = slot.active ? slot.itemIndex : slot.lastItemIndex;
    if (idx >= start && idx < end) {
      slot.invalidated = true;
      slot.measuredSize = -1.0;
    }
  }
}

void SlotPool::remapIndices(const double* pairs, int32_t pairCount, int32_t newItemCount) {
  if (slots_.empty()) return;
  if (pairs == nullptr || pairCount <= 0 || newItemCount <= 0) {
    reset();
    return;
  }

  // Detect contiguous shift fast-path (common prepend/remove-head case).
  bool contiguous = true;
  int32_t oldStart = static_cast<int32_t>(pairs[0]);
  int32_t newStart = static_cast<int32_t>(pairs[1]);
  if (!std::isfinite(pairs[0]) || !std::isfinite(pairs[1]) ||
      pairs[0] != std::floor(pairs[0]) || pairs[1] != std::floor(pairs[1]) ||
      oldStart < 0 || newStart < 0) {
    contiguous = false;
  } else {
    for (int32_t p = 0; p < pairCount; ++p) {
      if (pairs[p * 2] != oldStart + p || pairs[p * 2 + 1] != newStart + p) {
        contiguous = false;
        break;
      }
    }
  }

  std::unordered_map<int32_t, int32_t> oldToNew;
  if (!contiguous) {
    oldToNew.reserve(static_cast<size_t>(pairCount));
    for (int32_t p = 0; p < pairCount; ++p) {
      const double oldRaw = pairs[p * 2];
      const double newRaw = pairs[p * 2 + 1];
      if (!std::isfinite(oldRaw) || !std::isfinite(newRaw) ||
          oldRaw < 0.0 || newRaw < 0.0 || oldRaw > 2000000000.0 || newRaw > 2000000000.0) {
        continue;
      }
      const auto oldIdx = static_cast<int32_t>(oldRaw);
      const auto newIdx = static_cast<int32_t>(newRaw);
      if (newIdx >= 0 && newIdx < newItemCount) {
        oldToNew[oldIdx] = newIdx;
      }
    }
  }

  auto mapIndex = [&](int32_t oldIdx) -> int32_t {
    if (oldIdx < 0) return -1;
    if (contiguous) {
      if (oldIdx >= oldStart && oldIdx < oldStart + pairCount) {
        const int32_t next = newStart + (oldIdx - oldStart);
        return (next >= 0 && next < newItemCount) ? next : -1;
      }
      return -1;
    }
    const auto it = oldToNew.find(oldIdx);
    return it == oldToNew.end() ? -1 : it->second;
  };

  activeByIndex_.clear();
  for (int32_t s = 0; s < static_cast<int32_t>(slots_.size()); ++s) {
    auto& slot = slots_[s];
    if (slot.active) {
      const int32_t mapped = mapIndex(slot.itemIndex);
      if (mapped >= 0) {
        slot.itemIndex = mapped;
        slot.lastItemIndex = mapped;
        activeByIndex_[mapped] = s;
      } else {
        slot.itemIndex = -1;
        slot.lastItemIndex = -1;
        slot.active = false;
        slot.parked = false;
        slot.invalidated = true;
        slot.inPlaceUpdate = false;
        slot.measuredSize = -1.0;
      }
    } else if (slot.parked) {
      const int32_t mapped = mapIndex(slot.lastItemIndex);
      if (mapped >= 0) {
        slot.lastItemIndex = mapped;
      } else {
        slot.lastItemIndex = -1;
        slot.invalidated = true;
        slot.measuredSize = -1.0;
      }
    }
  }
}

void SlotPool::setSlotViewTag(int32_t slotId, int32_t viewTag, bool measures) {
  if (slotId < 0 || slotId >= static_cast<int32_t>(slots_.size())) return;
  slots_[slotId].viewTag = viewTag;
  slots_[slotId].measures = measures;
}

void SlotPool::unregisterSlotView(int32_t slotId) {
  if (slotId < 0 || slotId >= static_cast<int32_t>(slots_.size())) return;
  slots_[slotId].viewTag = 0;
}

void SlotPool::setSlotMeasures(int32_t slotId, bool measures) {
  if (slotId < 0 || slotId >= static_cast<int32_t>(slots_.size())) return;
  slots_[slotId].measures = measures;
}

void SlotPool::markSlotCommitted(int32_t slotId, uint32_t generation) {
  if (slotId < 0 || slotId >= static_cast<int32_t>(slots_.size())) return;
  slots_[slotId].committedGen = generation;
  if (slots_[slotId].committedGen == slots_[slotId].generation) {
    slots_[slotId].inPlaceUpdate = false;
  }
}

int32_t SlotPool::distanceToRange(int32_t index, int32_t low, int32_t high) const {
  if (index < 0) return std::numeric_limits<int32_t>::max();
  if (index < low) return low - index;
  if (index > high) return index - high;
  return 0;
}

int32_t SlotPool::pickBestFreeSlot(const std::vector<int32_t>& freeSlots,
                                   int32_t wantIndex,
                                   uint16_t wantType,
                                   int32_t rangeLow,
                                   int32_t rangeHigh,
                                   bool& outAffinityReused) {
  outAffinityReused = false;
  if (freeSlots.empty()) return -1;

  // Priority 1: Exact item affinity on same type (and not invalidated).
  for (int32_t pos = 0; pos < static_cast<int32_t>(freeSlots.size()); ++pos) {
    const int32_t slotId = freeSlots[pos];
    const auto& slot = slots_[slotId];
    if (slot.lastItemIndex == wantIndex && slot.itemType == wantType && !slot.invalidated) {
      outAffinityReused = true;
      return pos;
    }
  }

  // Priority 2: Same-type slot farthest from current range.
  int32_t bestSameTypePos = -1;
  int32_t bestSameTypeDist = -1;
  // Priority 3: Any free slot farthest from current range.
  int32_t bestAnyPos = -1;
  int32_t bestAnyDist = -1;

  for (int32_t pos = 0; pos < static_cast<int32_t>(freeSlots.size()); ++pos) {
    const int32_t slotId = freeSlots[pos];
    const auto& slot = slots_[slotId];
    const int32_t dist = distanceToRange(slot.lastItemIndex, rangeLow, rangeHigh);
    if (slot.itemType == wantType && dist > bestSameTypeDist) {
      bestSameTypeDist = dist;
      bestSameTypePos = pos;
    }
    if (dist > bestAnyDist) {
      bestAnyDist = dist;
      bestAnyPos = pos;
    }
  }

  return bestSameTypePos >= 0 ? bestSameTypePos : bestAnyPos;
}

int32_t SlotPool::reconcile(int32_t itemCount,
                            int32_t rangeStart,
                            int32_t rangeEnd,
                            const int32_t* extraIndices,
                            int32_t extraCount,
                            const std::function<uint16_t(int32_t)>& typeOf,
                            int32_t budgetSlots,
                            int32_t focusIndex,
                            std::vector<SlotDelta>& outDeltas) {
  outDeltas.clear();
  scratchDesired_.clear();
  scratchPending_.clear();
  scratchFree_.clear();
  hasMorePending_ = false;

  if (itemCount > 0) {
    if (rangeEnd >= rangeStart) {
      const int32_t lo = std::max(0, rangeStart);
      const int32_t hi = std::min(itemCount - 1, rangeEnd);
      if (hi >= lo) {
        scratchDesired_.reserve(static_cast<size_t>(hi - lo + 1 + std::max(0, extraCount)));
        for (int32_t i = lo; i <= hi; ++i) {
          scratchDesired_.push_back(i);
        }
      }
    }
    if (extraIndices != nullptr && extraCount > 0) {
      for (int32_t k = 0; k < extraCount; ++k) {
        const int32_t idx = extraIndices[k];
        if (idx >= 0 && idx < itemCount) {
          scratchDesired_.push_back(idx);
        }
      }
      std::sort(scratchDesired_.begin(), scratchDesired_.end());
      scratchDesired_.erase(std::unique(scratchDesired_.begin(), scratchDesired_.end()),
                            scratchDesired_.end());
    }
  }

  const int32_t rangeLow = scratchDesired_.empty() ? 0 : scratchDesired_.front();
  const int32_t rangeHigh = scratchDesired_.empty() ? -1 : scratchDesired_.back();

  // Track which existing slots are retained in place.
  scratchDesiredFlag_.assign(slots_.size(), 0);
  for (const int32_t idx : scratchDesired_) {
    const auto it = activeByIndex_.find(idx);
    if (it != activeByIndex_.end()) {
      const int32_t slotId = it->second;
      auto& slot = slots_[slotId];
      scratchDesiredFlag_[slotId] = 1;
      if (slot.invalidated) {
        slot.invalidated = false;
        slot.inPlaceUpdate = true;
        slot.generation = nextGen_++;
        slot.measuredSize = -1.0;
        slot.itemType = typeOf ? typeOf(idx) : 0;
        outDeltas.push_back(SlotDelta{
            slotId,
            idx,
            slot.generation,
            static_cast<uint8_t>(SlotDelta::kFlagActive | SlotDelta::kFlagItemChanged),
        });
      }
    } else {
      scratchPending_.push_back(idx);
    }
  }

  // Collect all slots not retained in place as free candidates.
  for (int32_t s = 0; s < static_cast<int32_t>(slots_.size()); ++s) {
    if (scratchDesiredFlag_[s] == 0) {
      scratchFree_.push_back(s);
    }
  }

  // Frame-budgeted pacing: prioritize items nearest focusIndex so viewport fills before overscan.
  int32_t assignLimit = static_cast<int32_t>(scratchPending_.size());
  if (budgetSlots > 0 && assignLimit > budgetSlots) {
    const int32_t anchor = focusIndex >= 0 ? focusIndex : (rangeLow + rangeHigh) / 2;
    std::stable_sort(scratchPending_.begin(), scratchPending_.end(),
                     [anchor](int32_t a, int32_t b) {
                       return std::abs(a - anchor) < std::abs(b - anchor);
                     });
    assignLimit = budgetSlots;
    hasMorePending_ = true;
  }

  // Assign pending items to free slots (affinity -> same type farthest -> any farthest -> create).
  for (int32_t k = 0; k < assignLimit; ++k) {
    const int32_t idx = scratchPending_[k];
    const uint16_t wantType = typeOf ? typeOf(idx) : 0;
    bool affinityReused = false;
    const int32_t freePos =
        pickBestFreeSlot(scratchFree_, idx, wantType, rangeLow, rangeHigh, affinityReused);

    int32_t slotId = -1;
    uint8_t flags = SlotDelta::kFlagActive;
    if (freePos >= 0) {
      slotId = scratchFree_[freePos];
      scratchFree_.erase(scratchFree_.begin() + freePos);
      auto& slot = slots_[slotId];
      if (slot.active && slot.itemIndex >= 0) {
        activeByIndex_.erase(slot.itemIndex);
      }
      const bool contentPreserved =
          affinityReused && slot.generation > 0 && slot.committedGen == slot.generation;
      if (!contentPreserved) {
        slot.generation = nextGen_++;
        slot.measuredSize = -1.0;
        flags |= SlotDelta::kFlagItemChanged;
      }
      slot.active = true;
      slot.parked = false;
      slot.invalidated = false;
      slot.inPlaceUpdate = false;
      slot.itemIndex = idx;
      slot.lastItemIndex = idx;
      slot.itemType = wantType;
      activeByIndex_[idx] = slotId;
      outDeltas.push_back(SlotDelta{slotId, idx, slot.generation, flags});
    } else {
      slotId = static_cast<int32_t>(slots_.size());
      SlotRecord created;
      created.itemIndex = idx;
      created.lastItemIndex = idx;
      created.itemType = wantType;
      created.generation = nextGen_++;
      created.active = true;
      created.parked = false;
      created.measures = true;
      slots_.push_back(created);
      activeByIndex_[idx] = slotId;
      flags |= SlotDelta::kFlagCreated | SlotDelta::kFlagItemChanged;
      outDeltas.push_back(SlotDelta{slotId, idx, created.generation, flags});
    }
  }

  // Deactivate any remaining previously-active slots and enforce maxParked_ reserve cap.
  int32_t parkedCount = 0;
  // Sort remaining free slots by closeness to range so closest ones stay parked for fast back-scroll.
  if (static_cast<int32_t>(scratchFree_.size()) > maxParked_) {
    std::sort(scratchFree_.begin(), scratchFree_.end(), [&](int32_t a, int32_t b) {
      return distanceToRange(slots_[a].lastItemIndex, rangeLow, rangeHigh) <
             distanceToRange(slots_[b].lastItemIndex, rangeLow, rangeHigh);
    });
  }
  for (const int32_t slotId : scratchFree_) {
    auto& slot = slots_[slotId];
    const bool wasActive = slot.active;
    if (wasActive && slot.itemIndex >= 0) {
      activeByIndex_.erase(slot.itemIndex);
    }
    slot.active = false;
    slot.inPlaceUpdate = false;
    slot.itemIndex = -1;
    if (parkedCount < maxParked_ && !slot.invalidated && slot.lastItemIndex >= 0) {
      slot.parked = true;
      ++parkedCount;
    } else {
      slot.parked = false;
      slot.lastItemIndex = -1;
      slot.measuredSize = -1.0;
    }
    if (wasActive) {
      // Inactive delta (kFlagItemChanged == 0): native hides the view, JS does NOT re-render!
      outDeltas.push_back(SlotDelta{slotId, -1, slot.generation, 0});
    }
  }

  return static_cast<int32_t>(outDeltas.size());
}

size_t SlotPool::getMemoryFootprint() const {
  const size_t activeBuckets = activeByIndex_.bucket_count() > 1 ? activeByIndex_.bucket_count() : 0;
  return slots_.capacity() * sizeof(SlotRecord) +
         activeByIndex_.size() * (sizeof(std::pair<const int32_t, int32_t>) + 2 * sizeof(void*)) +
         activeBuckets * sizeof(void*) +
         scratchDesired_.capacity() * sizeof(int32_t) +
         scratchPending_.capacity() * sizeof(int32_t) +
         scratchFree_.capacity() * sizeof(int32_t) +
         scratchDesiredFlag_.capacity() * sizeof(uint8_t);
}

} // namespace margelo::nitro::nitrolist
