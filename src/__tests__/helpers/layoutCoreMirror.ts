import type {NitroListEngine} from '../../NitroListEngine.nitro';

const f32 = Math.fround;

const BUFFER_AHEAD_RATIO = 1.5;
const BUFFER_BEHIND_RATIO = 0.5;
const DIRECTIONAL_MIN_VELOCITY = 300;
const VELOCITY_STALE_MS = 200;
const VELOCITY_MIN_SAMPLE_MS = 4;
const REGIME_CONFIRM_SAMPLES = 2;
const TYPE_MEAN_SWEEP_THRESHOLD = 0.5;
const TYPE_MEAN_SWEEP_RELATIVE = 0.02;

function typeMeanSweepBar(appliedMean: number): number {
  return Math.max(TYPE_MEAN_SWEEP_THRESHOLD, Math.abs(appliedMean) * TYPE_MEAN_SWEEP_RELATIVE);
}
const MAX_TYPE_STATS = 4096;
const NOTHING_DIRTY = Number.MAX_SAFE_INTEGER;

function roundToOctave(value: number): number {
  return f32(Math.round(value * 8) / 8);
}

function upperBound(arr: number[], lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(arr: number[], lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type TypeStats = {mean: number; appliedMean: number; num: number; seeded: boolean};

export type EngagedRange = {start: number; end: number; version: number};

export class LayoutCoreMirror {
  private sizes: number[] = [];
  private offsets: number[] = [];
  private measured: number[] = [];
  private types: number[] = [];
  private typeAverages = false;
  private estimatesFrozen = false;
  private typeStats: TypeStats[] = [];
  private itemCount = 0;
  private estimate = 0;
  private totalSize = 0;
  private measurementEpsilon = 0;
  private minDirtyIndex = NOTHING_DIRTY;
  private layoutVersion = 0;
  private directionalBuffers = false;
  private columnCount = 1;
  private spans: number[] = [];
  private rowStart: number[] = [];
  private clock: () => number = () => Date.now();
  private lastSampleTimeMs = -1;
  private lastSampleOffset = 0;
  private velocity = 0;
  private regime = 0;
  private pendingRegime = 0;
  private pendingRegimeCount = 0;

  setClock(clock: (() => number) | null): void {
    this.clock = clock ?? (() => Date.now());
    this.velocity = 0;
    this.lastSampleTimeMs = -1;
    this.clearRegime();
  }

  private clearRegime(): void {
    this.regime = 0;
    this.pendingRegime = 0;
    this.pendingRegimeCount = 0;
  }

  setItemCount(count: number): boolean {
    if (count === this.itemCount || count < 0) return false;
    if (count > this.sizes.length) {
      while (this.sizes.length < count) {
        this.sizes.push(0);
        this.offsets.push(0);
        this.measured.push(0);
        this.types.push(0);
      }
    }
    while (this.spans.length < count) this.spans.push(1);
    if (count > this.itemCount) {
      for (let i = this.itemCount; i < count; i++) {
        this.sizes[i] = this.estimate;
        this.measured[i] = 0;
        this.types[i] = 0;
        this.spans[i] = 1;
      }
    } else {
      for (let i = count; i < this.itemCount; i++) {
        this.sizes[i] = 0;
        this.measured[i] = 0;
      }
    }
    this.itemCount = count;
    this.minDirtyIndex = 0;
    return true;
  }

  setColumnCount(columns: number): void {
    const clamped = Math.max(1, Math.trunc(columns));
    if (clamped === this.columnCount) return;
    this.columnCount = clamped;
    this.typeStats = [];
    for (let i = 0; i < this.itemCount; i++) {
      this.measured[i] = 0;
      this.sizes[i] = this.estimate;
    }
    this.minDirtyIndex = 0;
  }

  setItemSpans(spans: ArrayLike<number> | null, count: number): boolean {
    while (this.spans.length < this.itemCount) this.spans.push(1);
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      const raw = spans != null && i < count ? Math.trunc(spans[i]) : 1;
      const next = raw < 1 ? 1 : raw;
      if (this.spans[i] !== next) {
        this.spans[i] = next;
        anyChanged = true;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    return anyChanged;
  }

  private spanAt(index: number): number {
    if (index >= this.spans.length) return 1;
    const span = this.spans[index] < 1 ? 1 : this.spans[index];
    return Math.min(span, this.columnCount);
  }

  setDirectionalBuffers(enabled: boolean): void {
    if (this.directionalBuffers === enabled) return;
    this.directionalBuffers = enabled;
    this.velocity = 0;
    this.lastSampleTimeMs = -1;
    this.clearRegime();
  }

  setEstimatesFrozen(frozen: boolean): boolean {
    if (this.estimatesFrozen === frozen) return false;
    this.estimatesFrozen = frozen;
    if (frozen) return false;
    return this.applyTypeMeans();
  }

  resetScrollVelocity(): void {
    this.velocity = 0;
    this.lastSampleTimeMs = -1;
    this.lastSampleOffset = 0;
    this.clearRegime();
  }

  setEstimate(value: number): boolean {
    const rounded = roundToOctave(value);
    if (rounded === this.estimate) return false;
    this.estimate = rounded;
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      if (
        this.measured[i] === 0 &&
        this.estimateForType(this.types[i]) === rounded &&
        this.sizes[i] !== rounded
      ) {
        this.sizes[i] = rounded;
        anyChanged = true;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    return anyChanged;
  }

  setMeasurementEpsilon(value: number): void {
    this.measurementEpsilon = Math.max(0, value);
  }

  setItemSize(index: number, size: number): boolean {
    if (index < 0 || index >= this.itemCount) return false;
    const rounded = Math.max(0, roundToOctave(size));
    if (this.measured[index] !== 0 && Math.abs(this.sizes[index] - rounded) <= this.measurementEpsilon) {
      return false;
    }
    this.updateTypeMean(index, this.measured[index] !== 0, this.sizes[index], rounded);
    this.sizes[index] = rounded;
    this.measured[index] = 1;
    this.minDirtyIndex = Math.min(this.minDirtyIndex, index);
    this.applyTypeMeans();
    return true;
  }

  setItemSizes(pairs: ArrayLike<number>, pairCount: number, scale: number): boolean {
    if (pairCount <= 0) return false;
    let anyChanged = false;
    for (let i = 0; i < pairCount; i++) {
      const idx = Math.trunc(pairs[i * 2]);
      if (idx < 0 || idx >= this.itemCount) continue;
      const rounded = Math.max(0, roundToOctave(pairs[i * 2 + 1] * scale));
      if (this.measured[idx] !== 0 && Math.abs(this.sizes[idx] - rounded) <= this.measurementEpsilon) {
        continue;
      }
      this.updateTypeMean(idx, this.measured[idx] !== 0, this.sizes[idx], rounded);
      this.sizes[idx] = rounded;
      this.measured[idx] = 1;
      this.minDirtyIndex = Math.min(this.minDirtyIndex, idx);
      anyChanged = true;
    }
    if (anyChanged) this.applyTypeMeans();
    return anyChanged;
  }

  setItemSizesAnchored(
    pairs: ArrayLike<number>,
    pairCount: number,
    scale: number,
    anchorIndex: number,
  ): number {
    const anchorValid = anchorIndex >= 0 && anchorIndex < this.itemCount;
    let before = 0;
    if (anchorValid) {
      this.ensureClean();
      before = this.offsets[anchorIndex];
    }
    const anyChanged = this.setItemSizes(pairs, pairCount, scale);
    if (!anchorValid || !anyChanged) return 0;
    this.ensureClean();
    return this.offsets[anchorIndex] - before;
  }

  resetItemSizes(): boolean {
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.measured[i] !== 0) {
        this.measured[i] = 0;
        anyChanged = true;
      }
      const target = this.estimateForType(this.types[i]);
      if (this.sizes[i] !== target) {
        this.sizes[i] = target;
        anyChanged = true;
      }
    }
    if (anyChanged) this.minDirtyIndex = 0;
    return anyChanged;
  }

  remapItemSizes(pairs: ArrayLike<number>, pairCount: number): boolean {
    if (pairCount <= 0 || this.itemCount === 0) return false;
    const newSizes: number[] = new Array(this.itemCount);
    const newMeasured: number[] = new Array(this.itemCount).fill(0);
    for (let i = 0; i < this.itemCount; i++) {
      newSizes[i] = this.estimateForType(this.types[i]);
    }
    const sourceLimit = this.sizes.length;
    for (let p = 0; p < pairCount; p++) {
      const oldRaw = pairs[p * 2];
      const newRaw = pairs[p * 2 + 1];
      if (!(oldRaw >= 0) || !(newRaw >= 0) || oldRaw > 2000000000 || newRaw > 2000000000) {
        continue;
      }
      const oldIdx = Math.trunc(oldRaw);
      const newIdx = Math.trunc(newRaw);
      if (oldIdx >= sourceLimit || newIdx >= this.itemCount) continue;
      if (this.measured[oldIdx] === 0) continue;
      newSizes[newIdx] = this.sizes[oldIdx];
      newMeasured[newIdx] = 1;
    }
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.measured[i] !== newMeasured[i]) {
        this.measured[i] = newMeasured[i];
        anyChanged = true;
      }
      if (this.sizes[i] !== newSizes[i]) {
        this.sizes[i] = newSizes[i];
        anyChanged = true;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    return anyChanged;
  }

  resetAll(): void {
    this.sizes = [];
    this.offsets = [];
    this.measured = [];
    this.types = [];
    this.typeStats = [];
    this.spans = [];
    this.rowStart = [];
    this.columnCount = 1;
    this.itemCount = 0;
    this.estimate = 0;
    this.totalSize = 0;
    this.estimatesFrozen = false;
    this.minDirtyIndex = NOTHING_DIRTY;
    this.layoutVersion = 0;
    this.lastSampleTimeMs = -1;
    this.lastSampleOffset = 0;
    this.velocity = 0;
    this.clearRegime();
  }

  setItemTypes(types: ArrayLike<number> | null, count: number): boolean {
    return this.assignTypes(0, types, count);
  }

  setItemTypesRange(start: number, types: ArrayLike<number> | null, count: number): boolean {
    if (start < 0 || start >= this.itemCount) return true;
    return this.assignTypes(start, types, Math.min(count, this.itemCount - start));
  }

  private assignTypes(start: number, types: ArrayLike<number> | null, count: number): boolean {
    while (this.types.length < this.itemCount) this.types.push(0);
    const end = start === 0 ? this.itemCount : Math.min(this.itemCount, start + Math.max(0, count));
    let allTracked = true;
    for (let i = start; i < end; i++) {
      const k = i - start;
      const type = types != null && k < count ? types[k] : 0;
      if (type >= MAX_TYPE_STATS) allTracked = false;
      this.types[i] = type;
    }
    for (let i = start; i < end; i++) {
      if (this.measured[i] !== 0) continue;
      const target = this.estimateForType(this.types[i]);
      if (this.sizes[i] !== target) {
        this.sizes[i] = target;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    return allTracked;
  }

  countUnmeasured(from: number, to: number): number {
    const lo = Math.max(0, from);
    const hi = Math.min(this.itemCount, to);
    let unmeasured = 0;
    for (let i = lo; i < hi; i++) {
      if (this.measured[i] === 0) unmeasured++;
    }
    return unmeasured;
  }

  seedTypeMeans(pairs: ArrayLike<number>, pairCount: number, scale: number): boolean {
    if (!this.typeAverages || pairCount <= 0) return false;
    let anySeeded = false;
    for (let p = 0; p < pairCount; p++) {
      const type = Math.trunc(pairs[2 * p]);
      const mean = roundToOctave(pairs[2 * p + 1] * scale);
      if (type <= 0 || type >= MAX_TYPE_STATS || !(mean > 0)) continue;
      while (this.typeStats.length <= type) {
        this.typeStats.push({mean: 0, appliedMean: 0, num: 0, seeded: false});
      }
      const stats = this.typeStats[type];
      if (stats.num > 0) continue;
      stats.mean = mean;
      stats.appliedMean = mean;
      stats.seeded = true;
      anySeeded = true;
    }
    if (!anySeeded) return false;
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.measured[i] !== 0) continue;
      const target = this.estimateForType(this.types[i]);
      if (this.sizes[i] !== target) {
        this.sizes[i] = target;
        anyChanged = true;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    return anyChanged;
  }

  setTypeAverages(enabled: boolean): void {
    if (this.typeAverages === enabled) return;
    this.typeAverages = enabled;
    this.typeStats = [];
  }

  getTotalSize(): number {
    this.ensureClean();
    return this.totalSize;
  }

  getOffset(index: number): number {
    if (index < 0 || index >= this.itemCount) return 0;
    this.ensureClean();
    return this.offsets[index];
  }

  getSize(index: number): number {
    if (index < 0 || index >= this.itemCount) return 0;
    return this.sizes[index];
  }

  getLayoutVersion(): number {
    this.ensureClean();
    return this.layoutVersion;
  }

  fillTypeStats(out: Float64Array, capacityDoubles: number, outputScale: number): number {
    let count = 0;
    for (const stats of this.typeStats) {
      if (stats.num > 0) count++;
    }
    if (capacityDoubles < count * 3) return -1;
    let cursor = 0;
    for (let type = 0; type < this.typeStats.length; type++) {
      const stats = this.typeStats[type];
      if (stats.num === 0) continue;
      out[cursor++] = type;
      out[cursor++] = stats.mean * outputScale;
      out[cursor++] = stats.num;
    }
    return count;
  }

  getTypeStatsSnapshot(): Array<{typeId: number; mean: number; num: number}> {
    const out: Array<{typeId: number; mean: number; num: number}> = [];
    for (let t = 0; t < this.typeStats.length; t++) {
      const stats = this.typeStats[t];
      if (stats.num > 0 || stats.seeded) out.push({typeId: t, mean: stats.mean, num: stats.num});
    }
    return out;
  }

  getEngagedRange(scrollOffset: number, viewportHeight: number, drawDistance: number): EngagedRange {
    if (this.directionalBuffers && scrollOffset !== this.lastSampleOffset) {
      const now = this.clock();
      let advanceBaseline = true;
      let sampled = false;
      if (this.lastSampleTimeMs >= 0) {
        const dt = now - this.lastSampleTimeMs;
        if (dt > VELOCITY_STALE_MS) {
          this.velocity = 0;
          sampled = true;
        } else if (dt >= VELOCITY_MIN_SAMPLE_MS) {
          this.velocity = ((scrollOffset - this.lastSampleOffset) / dt) * 1000;
          sampled = true;
        } else {
          advanceBaseline = false;
        }
      }
      if (advanceBaseline) {
        this.lastSampleTimeMs = now;
        this.lastSampleOffset = scrollOffset;
      }
      if (sampled) {
        let candidate = 0;
        if (Math.abs(this.velocity) >= DIRECTIONAL_MIN_VELOCITY) {
          candidate = this.velocity > 0 ? 1 : -1;
        }
        if (candidate === this.regime) {
          this.pendingRegime = 0;
          this.pendingRegimeCount = 0;
        } else if (candidate === 0 || this.regime !== 0) {
          this.regime = 0;
          this.pendingRegime = candidate;
          this.pendingRegimeCount = candidate === 0 ? 0 : 1;
        } else if (candidate === this.pendingRegime) {
          if (++this.pendingRegimeCount >= REGIME_CONFIRM_SAMPLES) {
            this.regime = candidate;
            this.pendingRegime = 0;
            this.pendingRegimeCount = 0;
          }
        } else {
          this.pendingRegime = candidate;
          this.pendingRegimeCount = 1;
        }
      }
    }
    const regime = this.directionalBuffers ? this.regime : 0;
    const topBuffer =
      regime === 0
        ? drawDistance
        : regime > 0
          ? drawDistance * BUFFER_BEHIND_RATIO
          : drawDistance * BUFFER_AHEAD_RATIO;
    const bottomBuffer =
      regime === 0
        ? drawDistance
        : regime > 0
          ? drawDistance * BUFFER_AHEAD_RATIO
          : drawDistance * BUFFER_BEHIND_RATIO;
    this.ensureClean();
    if (this.itemCount === 0 || viewportHeight <= 0) {
      return {start: 0, end: -1, version: this.layoutVersion};
    }
    const top = Math.max(0, scrollOffset - topBuffer);
    const bottom = Math.min(this.totalSize, scrollOffset + viewportHeight + bottomBuffer);
    if (this.totalSize <= top) {
      const lastStart =
        this.columnCount > 1 && this.rowStart.length > 0
          ? this.rowStart[this.itemCount - 1]
          : this.itemCount - 1;
      return {start: lastStart, end: this.itemCount - 1, version: this.layoutVersion};
    }
    let start = upperBound(this.offsets, 1, this.itemCount, top) - 1;
    let end = lowerBound(this.offsets, start, this.itemCount, bottom) - 1;
    end = Math.min(Math.max(end, start), this.itemCount - 1);
    if (this.columnCount > 1) {
      start = this.rowStart[start];
      const endRow = this.rowStart[end];
      while (end + 1 < this.itemCount && this.rowStart[end + 1] === endRow) end++;
    }
    return {start, end, version: this.layoutVersion};
  }

  fillLayoutSlab(
    out: Float64Array,
    capacityDoubles: number,
    scrollOffset: number,
    viewportHeight: number,
    drawDistance: number,
    outputScale: number,
  ): number {
    if (capacityDoubles < 4) return -1;
    const range = this.getEngagedRange(scrollOffset, viewportHeight, drawDistance);
    const count = range.end >= range.start ? range.end - range.start + 1 : 0;
    if (capacityDoubles < 4 + count * 2) return -1;
    out[0] = range.version;
    out[1] = this.totalSize * outputScale;
    out[2] = range.start;
    out[3] = range.end;
    let cursor = 4;
    for (let i = range.start; i < range.start + count; i++) {
      out[cursor++] = this.offsets[i] * outputScale;
      out[cursor++] = this.sizes[i] * outputScale;
    }
    return count;
  }

  private ensureClean(): void {
    if (this.minDirtyIndex === NOTHING_DIRTY) return;
    let anyChanged = false;
    if (this.columnCount <= 1) {
      let off =
        this.minDirtyIndex === 0
          ? 0
          : this.offsets[this.minDirtyIndex - 1] + this.sizes[this.minDirtyIndex - 1];
      for (let i = this.minDirtyIndex; i < this.itemCount; i++) {
        if (this.offsets[i] !== off) {
          this.offsets[i] = off;
          anyChanged = true;
        }
        off += this.sizes[i];
      }
      if (this.totalSize !== off) {
        this.totalSize = off;
        anyChanged = true;
      }
    } else {
      while (this.rowStart.length < this.itemCount) this.rowStart.push(0);
      let start = this.itemCount > 0 ? Math.min(this.minDirtyIndex, this.itemCount - 1) : 0;
      if (start > 0) start = this.rowStart[start];
      let off = 0;
      if (start > 0) {
        const prevRow = this.rowStart[start - 1];
        let prevRowMax = 0;
        for (let j = prevRow; j < start; j++) prevRowMax = Math.max(prevRowMax, this.sizes[j]);
        off = this.offsets[prevRow] + prevRowMax;
      }
      let i = start;
      while (i < this.itemCount) {
        const rowBegin = i;
        let used = 0;
        let rowMax = 0;
        while (i < this.itemCount) {
          const span = this.spanAt(i);
          if (used > 0 && used + span > this.columnCount) break;
          if (this.offsets[i] !== off) {
            this.offsets[i] = off;
            anyChanged = true;
          }
          this.rowStart[i] = rowBegin;
          rowMax = Math.max(rowMax, this.sizes[i]);
          used += span;
          i++;
          if (used >= this.columnCount) break;
        }
        off += rowMax;
      }
      if (this.totalSize !== off) {
        this.totalSize = off;
        anyChanged = true;
      }
    }
    this.minDirtyIndex = NOTHING_DIRTY;
    if (anyChanged) this.layoutVersion++;
  }

  private updateTypeMean(index: number, wasMeasured: boolean, prevSize: number, newSize: number): void {
    if (!this.typeAverages || newSize <= 0) return;
    const type = index < this.types.length ? this.types[index] : 0;
    if (type >= MAX_TYPE_STATS) return;
    while (this.typeStats.length <= type) {
      this.typeStats.push({mean: 0, appliedMean: 0, num: 0, seeded: false});
    }
    const stats = this.typeStats[type];
    if (wasMeasured) {
      if (stats.num > 0) {
        stats.mean += (newSize - prevSize) / stats.num;
      }
    } else {
      stats.mean = (stats.mean * stats.num + newSize) / (stats.num + 1);
      stats.num++;
    }
  }

  private applyTypeMeans(): boolean {
    if (!this.typeAverages || this.typeStats.length === 0 || this.estimatesFrozen) return false;
    let anyDrifted = false;
    for (const stats of this.typeStats) {
      if (stats.num > 0 && Math.abs(stats.mean - stats.appliedMean) > typeMeanSweepBar(stats.appliedMean)) {
        anyDrifted = true;
      }
    }
    if (!anyDrifted) return false;
    let anyChanged = false;
    for (let i = 0; i < this.itemCount; i++) {
      if (this.measured[i] !== 0) continue;
      const type = i < this.types.length ? this.types[i] : 0;
      if (type >= this.typeStats.length || this.typeStats[type].num === 0) continue;
      const stats = this.typeStats[type];
      if (Math.abs(stats.mean - stats.appliedMean) <= typeMeanSweepBar(stats.appliedMean)) continue;
      const rounded = roundToOctave(stats.mean);
      if (this.sizes[i] !== rounded) {
        this.sizes[i] = rounded;
        anyChanged = true;
        this.minDirtyIndex = Math.min(this.minDirtyIndex, i);
      }
    }
    for (const stats of this.typeStats) {
      if (stats.num > 0) stats.appliedMean = stats.mean;
    }
    return anyChanged;
  }

  private estimateForType(type: number): number {
    if (
      this.typeAverages &&
      type < this.typeStats.length &&
      (this.typeStats[type].num > 0 || this.typeStats[type].seeded)
    ) {
      return roundToOctave(this.typeStats[type].mean);
    }
    return this.estimate;
  }
}

export type HybridMirrorConfig = {
  measurementEpsilon?: number;
  directionalBuffers?: boolean;
  typeAverages?: boolean;
  asyncRangeDelivery?: boolean;
};

export type HybridMirrorProps = {
  itemCount: number;
  estimatedItemSize: number;
  drawDistance: number;
  horizontal?: boolean;
  numColumns?: number;
  onRangeChange?:
    | ((start: number, end: number, layoutVersion: number, offset: number) => void)
    | null;
};

export class HybridNitroListEngineMirror implements NitroListEngine {
  readonly core = new LayoutCoreMirror();
  name = 'NitroListEngineMirror';
  equals = (other: unknown): boolean => other === this;
  toString(): string {
    return this.name;
  }

  private scrollOffset = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private drawDistance = 0;
  private horizontal = false;
  private lastStart = -1;
  private lastEnd = -2;
  private lastVersion = -1;
  private isUpdatingProps = false;
  private rangeCallback:
    | ((start: number, end: number, layoutVersion: number, offset: number) => void)
    | null = null;

  readonly callLog: string[] = [];
  private readonly asyncRangeDelivery: boolean;
  private readonly explicitEpsilon: boolean;
  disposed = false;

  constructor(config: HybridMirrorConfig = {}) {
    this.explicitEpsilon = config.measurementEpsilon != null;
    this.core.setMeasurementEpsilon(config.measurementEpsilon ?? 0.51);
    this.core.setDirectionalBuffers(config.directionalBuffers ?? true);
    this.core.setTypeAverages(config.typeAverages ?? true);
    this.asyncRangeDelivery = config.asyncRangeDelivery ?? false;
  }

  get memorySize(): number {
    return 0;
  }

  dispose(): void {
    this.callLog.push('dispose');
    this.disposed = true;
  }

  get onRangeChange():
    | ((start: number, end: number, layoutVersion: number, offset: number) => void)
    | undefined {
    return this.rangeCallback ?? undefined;
  }

  set onRangeChange(
    value: ((start: number, end: number, layoutVersion: number, offset: number) => void) | undefined,
  ) {
    this.applyProps({onRangeChange: value ?? null});
  }

  configure(
    itemCount: number,
    estimatedItemSize: number,
    drawDistance: number,
    horizontal: boolean,
    numColumns: number,
    measurementEpsilon: number,
  ): void {
    this.callLog.push('configure');
    if (!this.explicitEpsilon) this.core.setMeasurementEpsilon(measurementEpsilon);
    this.applyProps({itemCount, estimatedItemSize, drawDistance, horizontal, numColumns});
  }

  applyProps(props: Partial<HybridMirrorProps>): void {
    this.isUpdatingProps = true;
    if (props.itemCount != null) this.core.setItemCount(Math.max(0, Math.trunc(props.itemCount)));
    if (props.estimatedItemSize != null) this.core.setEstimate(props.estimatedItemSize);
    if (props.drawDistance != null) this.drawDistance = props.drawDistance;
    if (props.horizontal != null) this.horizontal = props.horizontal;
    if (props.numColumns != null) this.core.setColumnCount(props.numColumns);
    if (props.onRangeChange !== undefined && props.onRangeChange !== this.rangeCallback) {
      this.rangeCallback = props.onRangeChange ?? null;
      this.lastStart = -1;
      this.lastEnd = -2;
      this.lastVersion = -1;
    }
    this.isUpdatingProps = false;
    this.maybeEmitRange();
  }

  getViewportSize(): {width: number; height: number} {
    return {width: this.viewportWidth, height: this.viewportHeight};
  }

  private mainViewport(): number {
    return this.horizontal ? this.viewportWidth : this.viewportHeight;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  setScrollOffset(offset: number): void {
    this.callLog.push('setScrollOffset');
    if (offset === this.scrollOffset) return;
    this.scrollOffset = offset;
    this.maybeEmitRange();
  }

  setScrollOffsetAndFill(offset: number, slab: ArrayBuffer): number {
    this.callLog.push('setScrollOffsetAndFill');
    const capacity = slab.byteLength / 8;
    if (capacity === 0) return -1;
    this.scrollOffset = offset;
    const typed = new Float64Array(slab);
    const written = this.core.fillLayoutSlab(
      typed,
      capacity,
      this.scrollOffset,
      this.mainViewport(),
      this.drawDistance,
      1,
    );
    if (written < 0) return -1;
    const version = typed[0];
    const start = typed[2];
    const end = typed[3];
    if (start === this.lastStart && end === this.lastEnd && version === this.lastVersion) {
      return 0;
    }
    this.lastStart = start;
    this.lastEnd = end;
    this.lastVersion = version;
    return written;
  }

  resetScrollVelocity(): void {
    this.callLog.push('resetScrollVelocity');
    this.core.resetScrollVelocity();
  }

  setEstimatesFrozen(frozen: boolean): void {
    this.callLog.push(`setEstimatesFrozen:${frozen}`);
    if (this.core.setEstimatesFrozen(frozen)) {
      this.maybeEmitRange();
    }
  }

  setViewport(width: number, height: number): void {
    this.callLog.push('setViewport');
    if (width === this.viewportWidth && height === this.viewportHeight) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.maybeEmitRange();
  }

  setItemSize(index: number, size: number): void {
    this.callLog.push('setItemSize');
    if (!this.core.setItemSize(index, size)) return;
    this.maybeEmitRange();
  }

  setItemSizesBatch(pairs: ArrayBuffer, emitRange: boolean): void {
    this.callLog.push('setItemSizesBatch');
    const typed = new Float64Array(pairs);
    const pairCount = typed.length >> 1;
    if (pairCount === 0) return;
    const changed = this.core.setItemSizes(typed, pairCount, 1);
    if (!changed) return;
    if (emitRange) this.maybeEmitRange();
  }

  setItemSizesBatchAnchored(pairs: ArrayBuffer, anchorIndex: number, emitRange: boolean): number {
    this.callLog.push('setItemSizesBatchAnchored');
    const typed = new Float64Array(pairs);
    const pairCount = typed.length >> 1;
    if (pairCount === 0) return 0;
    const diff = this.core.setItemSizesAnchored(typed, pairCount, 1, Math.trunc(anchorIndex));
    if (emitRange) this.maybeEmitRange();
    return diff;
  }

  resetItemSizes(): void {
    this.callLog.push('resetItemSizes');
    if (this.core.resetItemSizes()) {
      this.maybeEmitRange();
    }
  }

  remapItemSizes(pairs: ArrayBuffer): void {
    this.callLog.push('remapItemSizes');
    const typed = new Float64Array(pairs);
    const pairCount = typed.length >> 1;
    if (pairCount === 0) return;
    if (this.core.remapItemSizes(typed, pairCount)) {
      this.maybeEmitRange();
    }
  }

  setItemSpans(spans: ArrayBuffer): void {
    this.callLog.push('setItemSpans');
    const typed = new Uint16Array(spans);
    if (this.core.setItemSpans(typed.length === 0 ? null : typed, typed.length)) {
      this.maybeEmitRange();
    }
  }

  setItemTypes(types: ArrayBuffer): boolean {
    this.callLog.push('setItemTypes');
    const typed = new Uint16Array(types);
    const allTracked = this.core.setItemTypes(typed.length === 0 ? null : typed, typed.length);
    this.maybeEmitRange();
    return allTracked;
  }

  setItemTypesRange(start: number, types: ArrayBuffer): boolean {
    this.callLog.push('setItemTypesRange');
    const typed = new Uint16Array(types);
    if (typed.length === 0) return true;
    const allTracked = this.core.setItemTypesRange(Math.trunc(start), typed, typed.length);
    this.maybeEmitRange();
    return allTracked;
  }

  countUnmeasured(from: number, to: number): number {
    return this.core.countUnmeasured(Math.trunc(from), Math.trunc(to));
  }

  seedTypeMeans(pairs: ArrayBuffer): void {
    this.callLog.push('seedTypeMeans');
    const typed = new Float64Array(pairs);
    const pairCount = typed.length >> 1;
    if (pairCount === 0) return;
    if (this.core.seedTypeMeans(typed, pairCount, 1)) {
      this.maybeEmitRange();
    }
  }

  fillLayoutSlab(slab: ArrayBuffer): number {
    this.callLog.push('fillLayoutSlab');
    const capacity = slab.byteLength / 8;
    if (capacity === 0) return -1;
    return this.core.fillLayoutSlab(
      new Float64Array(slab),
      capacity,
      this.scrollOffset,
      this.mainViewport(),
      this.drawDistance,
      1,
    );
  }

  fillTypeStats(out: ArrayBuffer): number {
    this.callLog.push('fillTypeStats');
    const capacity = out.byteLength / 8;
    if (capacity === 0) return -1;
    return this.core.fillTypeStats(new Float64Array(out), capacity, 1);
  }

  getItemOffset(index: number): number {
    return this.core.getOffset(Math.trunc(index));
  }

  getItemSize(index: number): number {
    return this.core.getSize(Math.trunc(index));
  }

  getTotalSize(): number {
    return this.core.getTotalSize();
  }

  private maybeEmitRange(): void {
    const cb = this.rangeCallback;
    if (cb == null || this.isUpdatingProps) return;
    const range = this.core.getEngagedRange(this.scrollOffset, this.mainViewport(), this.drawDistance);
    if (range.start === this.lastStart && range.end === this.lastEnd && range.version === this.lastVersion) {
      return;
    }
    this.lastStart = range.start;
    this.lastEnd = range.end;
    this.lastVersion = range.version;
    const offset = this.scrollOffset;
    if (this.asyncRangeDelivery) {
      setTimeout(() => cb(range.start, range.end, range.version, offset), 0);
      return;
    }
    cb(range.start, range.end, range.version, offset);
  }
}
