export const SLOT_DELTA_FLAG_ACTIVE = 1 << 0;
export const SLOT_DELTA_FLAG_CREATED = 1 << 1;
export const SLOT_DELTA_FLAG_ITEM_CHANGED = 1 << 2;

export interface SlotSnapshot {
  readonly itemIndex: number;
  readonly generation: number;
  readonly active: boolean;
  readonly revision: number;
}

const EMPTY_SLOT: SlotSnapshot = Object.freeze({
  itemIndex: -1,
  generation: 0,
  active: false,
  revision: 0,
});

type Listener = () => void;

/**
 * Per-slot external store driven by C++ SlotPool deltas.
 *
 * - Parent container subscribes ONLY to `slotCount` (zero parent re-renders once warmed up).
 * - Each recycled slot subscribes ONLY to its own `slotId` (only the Δ entering/rebound
 *   slots re-render on scroll; unchanged and parked slots perform 0 React renders).
 */
export class SlotStore {
  private slotCount = 0;
  private readonly slots: SlotSnapshot[] = [];
  private readonly countListeners = new Set<Listener>();
  private readonly slotListeners = new Map<number, Set<Listener>>();

  getSlotCount(): number {
    return this.slotCount;
  }

  subscribeSlotCount(listener: Listener): () => void {
    this.countListeners.add(listener);
    return () => {
      this.countListeners.delete(listener);
    };
  }

  getSlot(slotId: number): SlotSnapshot {
    return slotId >= 0 && slotId < this.slots.length ? this.slots[slotId] : EMPTY_SLOT;
  }

  subscribeSlot(slotId: number, listener: Listener): () => void {
    let set = this.slotListeners.get(slotId);
    if (set == null) {
      set = new Set();
      this.slotListeners.set(slotId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set != null && set.size === 0) {
        this.slotListeners.delete(slotId);
      }
    };
  }

  /**
   * Applies packed Int32 deltas `[slotId, itemIndex, generation, flags]` emitted by C++ SlotPool.
   * Returns the number of individual slot listeners notified.
   */
  applyNativeDeltas(
    nextSlotCount: number,
    deltasBuffer: ArrayBuffer,
    intOffset = 0,
    deltaCountOverride?: number,
  ): number {
    const count = Math.max(0, Math.trunc(nextSlotCount));
    const countChanged = count !== this.slotCount;
    if (count > this.slots.length) {
      while (this.slots.length < count) {
        this.slots.push(EMPTY_SLOT);
      }
    }
    this.slotCount = count;

    const ints = new Int32Array(deltasBuffer);
    const availableDeltas = Math.max(0, Math.floor((ints.length - intOffset) / 4));
    const deltaCount =
      deltaCountOverride != null
        ? Math.min(Math.max(0, Math.trunc(deltaCountOverride)), availableDeltas)
        : availableDeltas;
    const toNotify: number[] = [];

    for (let k = 0; k < deltaCount; k++) {
      const base = intOffset + k * 4;
      const slotId = ints[base];
      const itemIndex = ints[base + 1];
      const generation = ints[base + 2];
      const flags = ints[base + 3];
      if (slotId < 0 || slotId >= this.slots.length) continue;

      const prev = this.slots[slotId];
      const active = (flags & SLOT_DELTA_FLAG_ACTIVE) !== 0;
      const itemChanged = (flags & (SLOT_DELTA_FLAG_CREATED | SLOT_DELTA_FLAG_ITEM_CHANGED)) !== 0;

      if (!active && !itemChanged) {
        // Slot parked/hidden: native UI thread handles visibility; keep previous itemIndex
        // intact so zero React re-render occurs on cell exit.
        if (prev.active) {
          this.slots[slotId] = {
            itemIndex: prev.itemIndex,
            generation: prev.generation,
            active: false,
            revision: prev.revision,
          };
        }
        continue;
      }

      if (
        prev.itemIndex !== itemIndex ||
        prev.generation !== generation ||
        prev.active !== active
      ) {
        this.slots[slotId] = {
          itemIndex,
          generation,
          active,
          revision: prev.revision + 1,
        };
        if (itemChanged) {
          toNotify.push(slotId);
        }
      }
    }

    if (countChanged && this.countListeners.size > 0) {
      for (const listener of Array.from(this.countListeners)) listener();
    }

    let notified = 0;
    for (let i = 0; i < toNotify.length; i++) {
      const set = this.slotListeners.get(toNotify[i]);
      if (set != null && set.size > 0) {
        notified++;
        for (const listener of Array.from(set)) listener();
      }
    }
    return notified;
  }

  /**
   * Remaps active slot indices in-place using the same `[oldIdx, newIdx]` pairs sent to C++
   * `SlotPool::remapIndices`, keeping each slot bound to the exact same item across prepends/moves
   * with zero wrong-item flashes.
   */
  remapIndices(pairs: Float64Array, pairCount: number, newItemCount: number): void {
    if (this.slotCount === 0 || pairCount <= 0) return;

    // Fast-path contiguous shift (common prepend / remove-head case).
    let contiguous = true;
    const oldStart = pairs[0];
    const newStart = pairs[1];
    if (
      !Number.isFinite(oldStart) ||
      !Number.isFinite(newStart) ||
      oldStart < 0 ||
      newStart < 0
    ) {
      contiguous = false;
    } else {
      for (let p = 0; p < pairCount; p++) {
        if (pairs[p * 2] !== oldStart + p || pairs[p * 2 + 1] !== newStart + p) {
          contiguous = false;
          break;
        }
      }
    }

    let map: Map<number, number> | null = null;
    if (!contiguous) {
      map = new Map<number, number>();
      for (let p = 0; p < pairCount; p++) {
        const oldIdx = pairs[p * 2];
        const newIdx = pairs[p * 2 + 1];
        if (newIdx >= 0 && newIdx < newItemCount) {
          map.set(oldIdx, newIdx);
        }
      }
    }

    const toNotify: number[] = [];
    for (let slotId = 0; slotId < this.slotCount; slotId++) {
      const prev = this.slots[slotId];
      if (!prev.active || prev.itemIndex < 0) continue;
      let mapped = -1;
      if (contiguous) {
        if (prev.itemIndex >= oldStart && prev.itemIndex < oldStart + pairCount) {
          const next = newStart + (prev.itemIndex - oldStart);
          if (next >= 0 && next < newItemCount) mapped = next;
        }
      } else if (map != null) {
        mapped = map.get(prev.itemIndex) ?? -1;
      }
      if (mapped >= 0) {
        if (mapped !== prev.itemIndex) {
          this.slots[slotId] = {
            itemIndex: mapped,
            generation: prev.generation,
            active: true,
            revision: prev.revision + 1,
          };
          toNotify.push(slotId);
        }
      } else {
        this.slots[slotId] = {
          itemIndex: -1,
          generation: prev.generation,
          active: false,
          revision: prev.revision + 1,
        };
      }
    }

    for (let i = 0; i < toNotify.length; i++) {
      const set = this.slotListeners.get(toNotify[i]);
      if (set != null && set.size > 0) {
        for (const listener of Array.from(set)) listener();
      }
    }
  }

  /**
   * Forces active slots to re-read items/props after an in-place data update or dataVersion bump.
   */
  bumpAllActiveSlots(): void {
    for (let slotId = 0; slotId < this.slotCount; slotId++) {
      const prev = this.slots[slotId];
      if (!prev.active || prev.itemIndex < 0) continue;
      this.slots[slotId] = {
        itemIndex: prev.itemIndex,
        generation: prev.generation,
        active: true,
        revision: prev.revision + 1,
      };
      const set = this.slotListeners.get(slotId);
      if (set != null && set.size > 0) {
        for (const listener of Array.from(set)) listener();
      }
    }
  }

  reset(): void {
    this.slotCount = 0;
    this.slots.length = 0;
    if (this.countListeners.size > 0) {
      for (const listener of Array.from(this.countListeners)) listener();
    }
  }
}
