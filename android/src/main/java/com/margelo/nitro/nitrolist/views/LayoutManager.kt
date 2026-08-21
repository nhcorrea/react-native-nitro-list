package com.margelo.nitro.nitrolist.views

import com.facebook.proguard.annotations.DoNotStrip
import java.nio.DoubleBuffer
import java.nio.ShortBuffer

@DoNotStrip
class LayoutManager {
  private val nativeHandle: Long = nativeCreate()

  private val rangeScratch = IntArray(3)

  fun setItemCount(count: Int): Boolean = nativeSetItemCount(nativeHandle, count)

  fun setEstimate(estimate: Float): Boolean = nativeSetEstimate(nativeHandle, estimate)

  fun setMeasurementEpsilon(epsilonPx: Float) = nativeSetMeasurementEpsilon(nativeHandle, epsilonPx)

  fun setDirectionalBuffers(enabled: Boolean) = nativeSetDirectionalBuffers(nativeHandle, enabled)

  fun resetScrollVelocity() = nativeResetScrollVelocity(nativeHandle)

  fun setEstimatesFrozen(frozen: Boolean): Boolean = nativeSetEstimatesFrozen(nativeHandle, frozen)

  fun setTypeAverages(enabled: Boolean) = nativeSetTypeAverages(nativeHandle, enabled)

  fun setItemTypes(types: ShortBuffer?, count: Int) = nativeSetItemTypes(nativeHandle, types, count)

  fun setColumnCount(columns: Int) = nativeSetColumnCount(nativeHandle, columns)

  fun setItemSpans(spans: ShortBuffer?, count: Int): Boolean =
    nativeSetItemSpans(nativeHandle, spans, count)

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

  fun fillTypeStats(out: DoubleBuffer, capacityDoubles: Int, outputScale: Float): Int =
    nativeFillTypeStats(nativeHandle, out, capacityDoubles, outputScale)

  fun setItemSize(index: Int, sizePx: Float): Boolean = nativeSetItemSize(nativeHandle, index, sizePx)

  fun setItemSizesDp(pairs: DoubleBuffer, count: Int, density: Float): Boolean =
    nativeSetItemSizesBatch(nativeHandle, pairs, count, density)

  fun setItemSizesDpAnchored(pairs: DoubleBuffer, count: Int, density: Float, anchorIndex: Int): Float =
    nativeSetItemSizesBatchAnchored(nativeHandle, pairs, count, density, anchorIndex)

  fun seedTypeMeansDp(pairs: DoubleBuffer, count: Int, density: Float): Boolean =
    nativeSeedTypeMeans(nativeHandle, pairs, count, density)

  fun resetItemSizes(): Boolean = nativeResetItemSizes(nativeHandle)

  fun remapItemSizes(pairs: DoubleBuffer, count: Int): Boolean =
    nativeRemapItemSizes(nativeHandle, pairs, count)

  fun resetAll() = nativeResetAll(nativeHandle)

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
  private external fun nativeResetScrollVelocity(handle: Long)
  private external fun nativeSetEstimatesFrozen(handle: Long, frozen: Boolean): Boolean
  private external fun nativeSetTypeAverages(handle: Long, enabled: Boolean)
  private external fun nativeSetItemTypes(handle: Long, types: ShortBuffer?, count: Int)
  private external fun nativeSetColumnCount(handle: Long, columns: Int)
  private external fun nativeSetItemSpans(handle: Long, spans: ShortBuffer?, count: Int): Boolean
  private external fun nativeFillLayoutSlab(
    handle: Long,
    slab: DoubleBuffer,
    capacityDoubles: Int,
    scrollOffset: Float,
    viewportHeight: Float,
    drawDistance: Float,
    outputScale: Float,
  ): Int
  private external fun nativeFillTypeStats(
    handle: Long,
    out: DoubleBuffer,
    capacityDoubles: Int,
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
  private external fun nativeRemapItemSizes(
    handle: Long,
    pairs: DoubleBuffer,
    pairCount: Int,
  ): Boolean
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
      System.loadLibrary("NitroList")
    }
  }
}
