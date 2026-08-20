package com.margelo.nitro.nitrolist

import android.view.View
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.nitrolist.views.LayoutManager
import com.margelo.nitro.nitrolist.views.NitroListContentView
import com.margelo.nitro.views.RecyclableView
import java.nio.ByteOrder

@DoNotStrip
class HybridNitroListView(context: ThemedReactContext) : HybridNitroListViewSpec(), RecyclableView {
  private val contentView = NitroListContentView(context)
  private val layoutManager = LayoutManager()
  private val density: Float = context.resources.displayMetrics.density

  private val stateLock = Any()

  private var scrollOffsetPx: Float = 0f
  private var viewportWPx: Float = 0f
  private var viewportHPx: Float = 0f
  private var drawDistancePx: Float = 0f
  private var lastStart: Int = -1
  private var lastEnd: Int = -2
  private var lastVersion: Int = -1
  private var isUpdatingProps = false
  private var lastRequestedTotalPx: Float = -1f

  init {
    contentView.bindLayoutManager(layoutManager)
    layoutManager.setMeasurementEpsilon(1f + 0.01f * density)
    layoutManager.setDirectionalBuffers(true)
    layoutManager.setTypeAverages(true)
  }

  override val view: View = contentView

  override val memorySize: Long
    get() = layoutManager.memoryFootprint()

  override var itemCount: Double = 0.0
    set(value) {
      field = value
      layoutManager.setItemCount(value.toInt().coerceAtLeast(0))
      maybeEmitRange()
    }

  override var estimatedItemSize: Double = 0.0
    set(value) {
      field = value
      layoutManager.setEstimate(dpToPx(value.toFloat()))
      maybeEmitRange()
    }

  override var drawDistance: Double = 0.0
    set(value) {
      field = value
      synchronized(stateLock) { drawDistancePx = dpToPx(value.toFloat()) }
      maybeEmitRange()
    }

  override var onRangeChange: ((start: Double, end: Double, layoutVersion: Double, offset: Double) -> Unit)? = null
    set(value) {
      field = value
      synchronized(stateLock) {
        lastStart = -1
        lastEnd = -2
        lastVersion = -1
      }
      maybeEmitRange()
    }

  override fun beforeUpdate() {
    synchronized(stateLock) { isUpdatingProps = true }
  }

  override fun afterUpdate() {
    synchronized(stateLock) { isUpdatingProps = false }
    val totalPx = layoutManager.getTotalSizePx()
    val needsLayout = synchronized(stateLock) {
      if (totalPx == lastRequestedTotalPx) {
        false
      } else {
        lastRequestedTotalPx = totalPx
        true
      }
    }
    if (needsLayout) contentView.requestLayout()
    maybeEmitRange()
  }

  override fun onDropView() {
    synchronized(stateLock) { layoutManager.resetAll() }
    onRangeChange = null
  }

  override fun prepareForRecycle() {
    synchronized(stateLock) {
      layoutManager.resetAll()
      scrollOffsetPx = 0f
      viewportWPx = 0f
      viewportHPx = 0f
      lastStart = -1
      lastEnd = -2
      lastVersion = -1
      lastRequestedTotalPx = -1f
    }
  }

  override fun setScrollOffset(offset: Double) {
    val px = dpToPx(offset.toFloat())
    val changed = synchronized(stateLock) {
      if (px == scrollOffsetPx) {
        false
      } else {
        scrollOffsetPx = px
        true
      }
    }
    if (changed) maybeEmitRange()
  }

  override fun setScrollOffsetAndFill(offset: Double, slab: ArrayBuffer): Double {
    val doubles = slab.getBuffer(false).order(ByteOrder.nativeOrder()).asDoubleBuffer()
    val capacity = doubles.remaining()
    if (capacity == 0) return -1.0
    val px = dpToPx(offset.toFloat())
    val written = synchronized(stateLock) {
      scrollOffsetPx = px
      val w = layoutManager.fillLayoutSlab(
        doubles,
        capacity,
        scrollOffsetPx,
        viewportHPx,
        drawDistancePx,
        1f / density,
      )
      if (w < 0) {
        -1
      } else {
        val version = doubles.get(0).toInt()
        val start = doubles.get(2).toInt()
        val end = doubles.get(3).toInt()
        if (start == lastStart && end == lastEnd && version == lastVersion) {
          0
        } else {
          lastStart = start
          lastEnd = end
          lastVersion = version
          w
        }
      }
    }
    return written.toDouble()
  }

  override fun resetScrollVelocity() {
    layoutManager.resetScrollVelocity()
  }

  override fun setEstimatesFrozen(frozen: Boolean) {
    val changed = layoutManager.setEstimatesFrozen(frozen)
    if (!changed) return
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun setViewport(width: Double, height: Double) {
    val w = dpToPx(width.toFloat())
    val h = dpToPx(height.toFloat())
    val changed = synchronized(stateLock) {
      if (w == viewportWPx && h == viewportHPx) {
        false
      } else {
        viewportWPx = w
        viewportHPx = h
        true
      }
    }
    if (changed) maybeEmitRange()
  }

  override fun resetItemSizes() {
    val changed = layoutManager.resetItemSizes()
    if (!changed) return
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun remapItemSizes(pairs: ArrayBuffer) {
    val doubles = pairs.getBuffer(false).order(ByteOrder.nativeOrder()).asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return
    val changed = layoutManager.remapItemSizes(doubles, pairCount)
    if (!changed) return
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun setItemTypes(types: ArrayBuffer) {
    val shorts = types.getBuffer(false).order(ByteOrder.nativeOrder()).asShortBuffer()
    layoutManager.setItemTypes(shorts, shorts.remaining())
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun seedTypeMeans(pairs: ArrayBuffer) {
    val buffer = pairs.getBuffer(false).order(ByteOrder.nativeOrder())
    val doubles = buffer.asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return
    val changed = layoutManager.seedTypeMeansDp(doubles, pairCount, density)
    if (!changed) return
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun fillLayoutSlab(slab: ArrayBuffer): Double {
    val doubles = slab.getBuffer(false).order(ByteOrder.nativeOrder()).asDoubleBuffer()
    val offset: Float
    val viewport: Float
    val draw: Float
    synchronized(stateLock) {
      offset = scrollOffsetPx
      viewport = viewportHPx
      draw = drawDistancePx
    }
    val written = layoutManager.fillLayoutSlab(
      doubles,
      doubles.remaining(),
      offset,
      viewport,
      draw,
      1f / density,
    )
    return written.toDouble()
  }

  override fun setItemSize(index: Double, size: Double) {
    val changed = layoutManager.setItemSize(index.toInt(), dpToPx(size.toFloat()))
    if (!changed) return
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun setItemSizesBatch(pairs: ArrayBuffer, emitRange: Boolean) {
    val buffer = pairs.getBuffer(false).order(ByteOrder.nativeOrder())
    val doubles = buffer.asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return
    val changed = layoutManager.setItemSizesDp(doubles, pairCount, density)
    if (!changed) return
    requestLayoutIfTotalChanged()
    if (emitRange) maybeEmitRange()
  }

  override fun setItemSizesBatchAnchored(pairs: ArrayBuffer, anchorIndex: Double, emitRange: Boolean): Double {
    val buffer = pairs.getBuffer(false).order(ByteOrder.nativeOrder())
    val doubles = buffer.asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return 0.0
    val diffPx = layoutManager.setItemSizesDpAnchored(doubles, pairCount, density, anchorIndex.toInt())
    requestLayoutIfTotalChanged()
    if (emitRange) maybeEmitRange()
    return pxToDp(diffPx).toDouble()
  }

  override fun getItemOffset(index: Double): Double {
    return pxToDp(layoutManager.getOffsetPx(index.toInt())).toDouble()
  }

  override fun getItemSize(index: Double): Double {
    return pxToDp(layoutManager.getSizePx(index.toInt())).toDouble()
  }

  override fun getTotalSize(): Double {
    return pxToDp(layoutManager.getTotalSizePx()).toDouble()
  }

  private fun requestLayoutIfTotalChanged() {
    val totalPx = layoutManager.getTotalSizePx()
    val changed = synchronized(stateLock) {
      if (totalPx == lastRequestedTotalPx) {
        false
      } else {
        lastRequestedTotalPx = totalPx
        true
      }
    }
    if (changed) contentView.post { contentView.requestLayout() }
  }

  private fun maybeEmitRange() {
    val callback = onRangeChange ?: return
    var emitStart = 0
    var emitEnd = 0
    var emitVersion = 0
    var emitOffsetPx = 0f
    val shouldEmit = synchronized(stateLock) {
      if (isUpdatingProps) return
      val range = layoutManager.getEngagedRange(scrollOffsetPx, viewportHPx, drawDistancePx)
      if (range.start == lastStart && range.end == lastEnd && range.version == lastVersion) {
        false
      } else {
        lastStart = range.start
        lastEnd = range.end
        lastVersion = range.version
        emitStart = range.start
        emitEnd = range.end
        emitVersion = range.version
        emitOffsetPx = scrollOffsetPx
        true
      }
    }
    if (shouldEmit) {
      callback(
        emitStart.toDouble(),
        emitEnd.toDouble(),
        emitVersion.toDouble(),
        pxToDp(emitOffsetPx).toDouble(),
      )
    }
  }

  private fun dpToPx(dp: Float): Float = dp * density

  private fun pxToDp(px: Float): Float = px / density
}
