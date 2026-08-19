package com.margelo.nitro.nitrolist.views

import com.facebook.proguard.annotations.DoNotStrip
import java.nio.DoubleBuffer
import java.nio.ShortBuffer

/**
 * Thin Kotlin adapter over the shared C++ layout engine (`cpp/LayoutCore.cpp`)
 * via JNI (`src/main/cpp/LayoutCoreJNI.cpp`). All layout math, caching (lazy
 * prefix sums, boundary-window range cache) and locking live in the C++ core —
 * shared 1:1 with iOS. This type only forwards calls and shapes the result
 * data class. All values are pixels.
 *
 * (Class and native-method names are load-bearing: JNI resolves the
 * `Java_com_margelo_nitro_nitrolist_views_LayoutManager_native*` symbols from
 * them. Default Android R8 rules keep names of classes with native methods;
 * `@DoNotStrip` documents/backs that contract.)
 */
@DoNotStrip
class LayoutManager {
  private val nativeHandle: Long = nativeCreate()

  // Scratch array filled by nativeGetEngagedRange. The C++ core serializes
  // internally, but two Java threads (JS + UI) can call concurrently and
  // would otherwise interleave writes into the same array.
  private val rangeScratch = IntArray(3)

  fun setItemCount(count: Int): Boolean = nativeSetItemCount(nativeHandle, count)

  fun setEstimate(estimate: Float): Boolean = nativeSetEstimate(nativeHandle, estimate)

  /**
   * Deltas ≤ epsilon (in px) are treated as measurement noise, not size
   * changes. Set once from the display density (≈1 physical pixel).
   */
  fun setMeasurementEpsilon(epsilonPx: Float) = nativeSetMeasurementEpsilon(nativeHandle, epsilonPx)

  /** Redistributes drawDistance by scroll direction (1.5× ahead / 0.5× behind). */
  fun setDirectionalBuffers(enabled: Boolean) = nativeSetDirectionalBuffers(nativeHandle, enabled)

  /** Per-type running means replace the global estimate for unmeasured items. */
  fun setTypeAverages(enabled: Boolean) = nativeSetTypeAverages(nativeHandle, enabled)

  /** One uint16 type id per index (direct ShortBuffer view; 0 = untyped). */
  fun setItemTypes(types: ShortBuffer?, count: Int) = nativeSetItemTypes(nativeHandle, types, count)

  /**
   * Fills `slab` with [version, total, start, end, (offset, size)…] × outputScale
   * (pass 1/density so JS receives dp). Returns items written or -1 when the
   * capacity (in doubles) is too small.
   */
  fun fillLayoutSlab(
    slab: DoubleBuffer,
    capacityDoubles: Int,
    scrollOffsetPx: Float,
    viewportHPx: Float,
    drawDistancePx: Float,
    outputScale: Float,
  ): Int = nativeFillLayoutSlab(
    nativeHandle, slab, capacityDoubles, scrollOffsetPx, viewportHPx, drawDistancePx, outputScale,
  )

  /** Returns true if the size for `index` actually changed. */
  fun setItemSize(index: Int, sizePx: Float): Boolean = nativeSetItemSize(nativeHandle, index, sizePx)

  /**
   * Batched `setItemSize`. `pairs` holds `count` (index, sizeDp) pairs as
   * consecutive doubles (a direct view over the JS Float64Array — zero-copy).
   * The density converts dp→px inside the core, once per pair under a single
   * lock.
   */
  fun setItemSizesDp(pairs: DoubleBuffer, count: Int, density: Float): Boolean =
    nativeSetItemSizesBatch(nativeHandle, pairs, count, density)

  /**
   * MVCP variant: applies the batch and returns the anchor's offset delta in
   * px (mutation + measurement under one native lock acquisition).
   */
  fun setItemSizesDpAnchored(pairs: DoubleBuffer, count: Int, density: Float, anchorIndex: Int): Float =
    nativeSetItemSizesBatchAnchored(nativeHandle, pairs, count, density, anchorIndex)

  /**
   * Seeds per-type means from JS's cross-mount cache. `pairs` holds `count`
   * (typeId, meanDp) pairs as consecutive doubles; the density converts dp→px
   * inside the core. Seeds never beat real samples nor mark items measured.
   */
  fun seedTypeMeansDp(pairs: DoubleBuffer, count: Int, density: Float): Boolean =
    nativeSeedTypeMeans(nativeHandle, pairs, count, density)

  /**
   * Forgets every measured size and reverts all items to the current
   * estimate. Used on structural data changes. Returns true if anything
   * changed.
   */
  fun resetItemSizes(): Boolean = nativeResetItemSizes(nativeHandle)

  /** Full reset for Fabric view recycling; wrapper-set config survives. */
  fun resetAll() = nativeResetAll(nativeHandle)

  /** Bytes of heap storage owned by the item arrays (capacity-based). */
  fun memoryFootprint(): Long = nativeGetMemoryFootprint(nativeHandle)

  fun getTotalSizePx(): Float = nativeGetTotalSize(nativeHandle)

  fun getOffsetPx(index: Int): Float = nativeGetOffset(nativeHandle, index)

  fun getSizePx(index: Int): Float = nativeGetSize(nativeHandle, index)

  fun getLayoutVersion(): Int = nativeGetLayoutVersion(nativeHandle)

  data class EngagedRange(val start: Int, val end: Int, val version: Int)

  fun getEngagedRange(scrollOffsetPx: Float, viewportHPx: Float, drawDistancePx: Float): EngagedRange =
    synchronized(rangeScratch) {
      nativeGetEngagedRange(nativeHandle, scrollOffsetPx, viewportHPx, drawDistancePx, rangeScratch)
      EngagedRange(rangeScratch[0], rangeScratch[1], rangeScratch[2])
    }

  @Suppress("deprecation")
  protected fun finalize() {
    nativeDestroy(nativeHandle)
  }

  private external fun nativeCreate(): Long
  private external fun nativeDestroy(handle: Long)
  private external fun nativeSetItemCount(handle: Long, count: Int): Boolean
  private external fun nativeSetEstimate(handle: Long, value: Float): Boolean
  private external fun nativeSetMeasurementEpsilon(handle: Long, value: Float)
  private external fun nativeSetDirectionalBuffers(handle: Long, enabled: Boolean)
  private external fun nativeSetTypeAverages(handle: Long, enabled: Boolean)
  private external fun nativeSetItemTypes(handle: Long, types: ShortBuffer?, count: Int)
  private external fun nativeFillLayoutSlab(
    handle: Long,
    slab: DoubleBuffer,
    capacityDoubles: Int,
    scrollOffset: Float,
    viewportHeight: Float,
    drawDistance: Float,
    outputScale: Float,
  ): Int
  private external fun nativeSetItemSize(handle: Long, index: Int, size: Float): Boolean
  private external fun nativeSetItemSizesBatch(
    handle: Long,
    pairs: DoubleBuffer,
    pairCount: Int,
    scale: Float,
  ): Boolean
  private external fun nativeSetItemSizesBatchAnchored(
    handle: Long,
    pairs: DoubleBuffer,
    pairCount: Int,
    scale: Float,
    anchorIndex: Int,
  ): Float
  private external fun nativeSeedTypeMeans(
    handle: Long,
    pairs: DoubleBuffer,
    pairCount: Int,
    scale: Float,
  ): Boolean
  private external fun nativeResetItemSizes(handle: Long): Boolean
  private external fun nativeResetAll(handle: Long)
  private external fun nativeGetMemoryFootprint(handle: Long): Long
  private external fun nativeGetTotalSize(handle: Long): Float
  private external fun nativeGetOffset(handle: Long, index: Int): Float
  private external fun nativeGetSize(handle: Long, index: Int): Float
  private external fun nativeGetLayoutVersion(handle: Long): Int
  private external fun nativeGetEngagedRange(
    handle: Long,
    scrollOffset: Float,
    viewportHeight: Float,
    drawDistance: Float,
    out: IntArray,
  )

  companion object {
    init {
      // Idempotent — normally already loaded by the generated NitroListOnLoad,
      // but the first LayoutManager may be constructed from either entry point.
      System.loadLibrary("NitroList")
    }
  }
}
