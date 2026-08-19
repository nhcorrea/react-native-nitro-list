package com.margelo.nitro.nitrolist

import android.view.View
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.core.ArrayBuffer
import com.margelo.nitro.nitrolist.views.LayoutManager
import com.margelo.nitro.nitrolist.views.NitroListContentView
import com.margelo.nitro.views.RecyclableView
import java.nio.ByteOrder

/**
 * Android HybridView for `NitroListView`. Thin glue between JS (Nitro/JSI)
 * and the shared C++ `LayoutCore` (via the `LayoutManager` JNI adapter).
 *
 * Threading (guides/view-components.md: thread-safety is ours to ensure):
 * - Prop setters + `beforeUpdate`/`afterUpdate` run on the UI thread
 *   (Fabric `updateProps`).
 * - Hybrid methods run synchronously on the JS thread via JSI — and, with the
 *   experimental UI-thread scroll driver, `setScrollOffset` can also arrive
 *   from the UI-thread worklet runtime.
 * All mutable wrapper state is guarded by `stateLock`. Lock ordering:
 * stateLock → LayoutCore's mutex (never the reverse). `onRangeChange` is
 * NEVER invoked while holding the lock (snapshot, unlock, call).
 */
@DoNotStrip
class HybridNitroListView(context: ThemedReactContext) : HybridNitroListViewSpec(), RecyclableView {
  private val contentView = NitroListContentView(context)
  private val layoutManager = LayoutManager()
  private val density: Float = context.resources.displayMetrics.density

  private val stateLock = Any()

  // ---- State guarded by stateLock (pixels) ----------------------------------
  private var scrollOffsetPx: Float = 0f
  private var viewportWPx: Float = 0f
  private var viewportHPx: Float = 0f
  private var drawDistancePx: Float = 0f
  // Last range emitted to JS — used to skip duplicate callbacks.
  private var lastStart: Int = -1
  private var lastEnd: Int = -2
  private var lastVersion: Int = -1
  // True between beforeUpdate() and afterUpdate(): setters skip per-prop range
  // recomputation and afterUpdate() does it once for the whole commit.
  private var isUpdatingProps = false
  // Total size (px) at the time of the last requestLayout. The host view's
  // measured height only depends on the total, so size mutations that don't
  // move the total don't need a native layout pass at all.
  private var lastRequestedTotalPx: Float = -1f

  init {
    contentView.bindLayoutManager(layoutManager)
    // ≈1 physical pixel in px: measurement deltas below this are layout
    // jitter, not real size changes (they survive the 1/8px octave).
    layoutManager.setMeasurementEpsilon(1f + 0.01f * density)
    // Same total draw budget, redistributed toward the scroll direction
    // (1.5×/0.5×). Single-line rollback if it ever misbehaves.
    layoutManager.setDirectionalBuffers(true)
    // Per-type running means (fed by real measurements) replace the global
    // estimate for unmeasured items. Single-line rollback likewise.
    layoutManager.setTypeAverages(true)
  }

  override val view: View = contentView

  /**
   * Native weight of the layout arrays — lets the JS GC see the real size of
   * large lists instead of ~0 bytes (performance-tips: memorySize).
   */
  override val memorySize: Long
    get() = layoutManager.memoryFootprint()

  // ---- Props (set on UI thread by Fabric) -----------------------------------

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
      // Re-emit the current range so a freshly-mounted JS subscriber catches up.
      synchronized(stateLock) {
        lastStart = -1
        lastEnd = -2
        lastVersion = -1
      }
      maybeEmitRange()
    }

  // ---- View lifecycle (Fabric) ----------------------------------------------

  override fun beforeUpdate() {
    synchronized(stateLock) { isUpdatingProps = true }
  }

  override fun afterUpdate() {
    // One engaged-range computation (and at most one requestLayout) per props
    // commit instead of one per dirty setter (view-components.md: batch here).
    synchronized(stateLock) { isUpdatingProps = false }
    // afterUpdate runs on the UI thread — requestLayout can go direct.
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
    // Unmount: release the layout arrays and the strong ref to the JS callback.
    synchronized(stateLock) { layoutManager.resetAll() }
    onRangeChange = null
  }

  /**
   * Fabric view recycling (opt-in via `RecyclableView`): the next use must
   * behave exactly like a fresh instance — stale ranges/sizes would show the
   * previous list's geometry. Wrapper-set core config (epsilon, directional
   * buffers, type averages) survives; props are re-applied by Fabric.
   */
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

  // ---- Hybrid methods (called from JS thread via JSI) -----------------------

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
    // One stateLock acquisition covers offset write + fill + dedupe: no
    // concurrent mutation can interleave between "what range did I get" and
    // "what range did I mark as delivered". Slab layout (fillLayoutSlab):
    // [layoutVersion, totalSize, start, end, (offset, size)…] in dp.
    val written = synchronized(stateLock) {
      scrollOffsetPx = px
      val w = layoutManager.fillLayoutSlab(
        doubles,
        capacity,
        scrollOffsetPx,
        viewportHPx,
        drawDistancePx,
        // Native works in px; JS reads dp.
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
          // Mark as delivered — onRangeChange must stay silent for this range.
          lastStart = start
          lastEnd = end
          lastVersion = version
          w
        }
      }
    }
    return written.toDouble()
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

  override fun setItemTypes(types: ArrayBuffer) {
    // Direct Uint16 view over the JS buffer — zero-copy, consumed synchronously.
    val shorts = types.getBuffer(false).order(ByteOrder.nativeOrder()).asShortBuffer()
    layoutManager.setItemTypes(shorts, shorts.remaining())
    // Unmeasured sizes may have been re-resolved against the new types.
    requestLayoutIfTotalChanged()
    maybeEmitRange()
  }

  override fun seedTypeMeans(pairs: ArrayBuffer) {
    // Zero-copy view over the JS Float64Array; consumed synchronously.
    val buffer = pairs.getBuffer(false).order(ByteOrder.nativeOrder())
    val doubles = buffer.asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return
    val changed = layoutManager.seedTypeMeansDp(doubles, pairCount, density)
    if (!changed) return
    // Unmeasured sizes re-resolved against the seeded means.
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
      // Native works in px; JS reads dp.
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
    // Zero-copy: we consume the buffer synchronously, so the JS-allocated
    // memory stays valid for the duration of this call. `getBuffer(false)`
    // returns the underlying NIO ByteBuffer without an intermediate copy.
    val buffer = pairs.getBuffer(false).order(ByteOrder.nativeOrder())
    val doubles = buffer.asDoubleBuffer()
    val pairCount = doubles.remaining() / 2
    if (pairCount == 0) return
    val changed = layoutManager.setItemSizesDp(doubles, pairCount, density)
    if (!changed) return
    // requestLayout is the view's own height sync — it must run even on a
    // silent apply; only the range emission is the caller's to suppress
    // (a setScrollOffsetAndFill follows and delivers the range itself).
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

  // ---------------------------------------------------------------------------

  /**
   * Posts a requestLayout to the UI thread only when the total content size
   * actually moved. Size changes that keep the total intact (duplicate
   * measurements, offsetting deltas) previously still cost a native
   * measure pass per batch. Called from the JS thread, hence the `post`.
   */
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
    // Single read of the callback ref; never invoked under stateLock.
    val callback = onRangeChange ?: return
    var emitStart = 0
    var emitEnd = 0
    var emitVersion = 0
    // Offset snapshotted under the same lock as the range — JS re-syncs its
    // scroll bookkeeping from it when the UI-thread worklet is the driver.
    var emitOffsetPx = 0f
    val shouldEmit = synchronized(stateLock) {
      if (isUpdatingProps) return // afterUpdate() emits once for the batch
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

  // Multiplication is equivalent to `TypedValue.applyDimension(COMPLEX_UNIT_DIP, dp, dm)`
  // and avoids the DisplayMetrics lookup + switch on every hot-path JSI call.
  private fun dpToPx(dp: Float): Float = dp * density

  private fun pxToDp(px: Float): Float = px / density
}
