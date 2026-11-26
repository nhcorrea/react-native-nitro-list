package com.margelo.nitro.nitrolist

import android.net.Uri
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.HorizontalScrollView
import android.widget.OverScroller
import android.widget.ScrollView
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.R
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.UIManagerListener
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.uimanager.IllegalViewOperationException
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewHelper
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.ArrayBuffer
import java.lang.ref.WeakReference
import java.lang.reflect.Method
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.roundToInt

internal object NativeHostBridge {
  @JvmStatic external fun nativeOnScroll(
    engineId: Long,
    absoluteOffsetDp: Double,
    velocityDpS: Double,
    budgetSlots: Int,
    captureAnchor: Boolean,
    jsLatencyMs: Double,
    outHeader: DoubleArray,
    outDeltas: IntArray,
  ): Int

  @JvmStatic external fun nativeApplySlotSizes(
    engineId: Long,
    slotIds: IntArray,
    sizesDp: DoubleArray,
    seenGens: IntArray,
    count: Int,
    applyMvcp: Boolean,
    outHeader: DoubleArray,
  ): Boolean

  @JvmStatic external fun nativeReadTransforms(
    engineId: Long,
    outOffsetsDp: DoubleArray,
    outMeta: IntArray,
    maxSlots: Int,
    outHeader: DoubleArray,
  ): Int

  @JvmStatic external fun nativeSetSlotViewTag(
    engineId: Long,
    slotId: Int,
    viewTag: Int,
    measures: Boolean,
  )

  @JvmStatic external fun nativeUnregisterSlotView(
    engineId: Long,
    slotId: Int,
  )

  @JvmStatic external fun nativeSetSlotMeasures(
    engineId: Long,
    slotId: Int,
    measures: Boolean,
  )

  @JvmStatic external fun nativeSetMvcpEnabled(
    engineId: Long,
    enabled: Boolean,
  )

  @JvmStatic external fun nativeUpdateHostGeometry(
    engineId: Long,
    paddingStartDp: Double,
    mainAxisGapDp: Double,
  )

  @JvmStatic external fun nativeOnMomentumEnd(
    engineId: Long,
    absoluteOffsetDp: Double,
  )

  @JvmStatic external fun nativeIsPrewarmActive(
    engineId: Long,
  ): Boolean

  @JvmStatic external fun nativeReadTemplateSlots(
    engineId: Long,
    outOffsetsDp: DoubleArray,
    outInfo: IntArray,
    maxSlots: Int,
    outHeader: DoubleArray,
  ): Int
}

@Keep
@DoNotStrip
class HybridNitroListNativeHost : HybridNitroListNativeHostSpec() {
  override fun attachHost(
    engineId: Double,
    scrollViewTag: Double,
    stickyViewTag: Double,
    horizontal: Boolean,
    userHasOnScroll: Boolean,
    onSlotRebinds: (
      slotCount: Double,
      rangeStart: Double,
      rangeEnd: Double,
      layoutVersion: Double,
      totalSize: Double,
      stickyIndex: Double,
      velocityDpS: Double,
      deltas: ArrayBuffer,
    ) -> Unit,
    onContentSize: (totalSize: Double, layoutVersion: Double) -> Unit,
  ): Double {
    if (!engineId.isFinite() || engineId <= 0 || !scrollViewTag.isFinite() || scrollViewTag <= 0) {
      return -1.0
    }
    return NativeHostManager.attach(
      engineId = engineId.toLong(),
      scrollViewTag = scrollViewTag.toInt(),
      stickyViewTag = if (stickyViewTag.isFinite() && stickyViewTag > 0) stickyViewTag.toInt() else -1,
      horizontal = horizontal,
      userHasOnScroll = userHasOnScroll,
      onSlotRebinds = onSlotRebinds,
      onContentSize = onContentSize,
    ).toDouble()
  }

  override fun detachHost(hostId: Double) {
    if (hostId.isFinite() && hostId > 0) {
      NativeHostManager.detach(hostId.toInt())
    }
  }

  override fun registerSlotView(hostId: Double, slotId: Double, viewTag: Double, measures: Boolean) {
    if (!hostId.isFinite() || hostId <= 0 || !slotId.isFinite() || slotId < 0 || !viewTag.isFinite() || viewTag <= 0) return
    NativeHostManager.registerSlotView(hostId.toInt(), slotId.toInt(), viewTag.toInt(), measures)
  }

  override fun unregisterSlotView(hostId: Double, slotId: Double) {
    if (!hostId.isFinite() || hostId <= 0 || !slotId.isFinite() || slotId < 0) return
    NativeHostManager.unregisterSlotView(hostId.toInt(), slotId.toInt())
  }

  override fun setSlotMeasures(hostId: Double, slotId: Double, measures: Boolean) {
    if (!hostId.isFinite() || hostId <= 0 || !slotId.isFinite() || slotId < 0) return
    NativeHostManager.setSlotMeasures(hostId.toInt(), slotId.toInt(), measures)
  }

  override fun setStickyViewTag(hostId: Double, stickyViewTag: Double) {
    if (!hostId.isFinite() || hostId <= 0) return
    val tag = if (stickyViewTag.isFinite() && stickyViewTag > 0) stickyViewTag.toInt() else -1
    NativeHostManager.setStickyViewTag(hostId.toInt(), tag)
  }

  override fun setUserHasOnScroll(hostId: Double, hasOnScroll: Boolean) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.setUserHasOnScroll(hostId.toInt(), hasOnScroll)
  }

  override fun setMvcpEnabled(hostId: Double, enabled: Boolean) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.setMvcpEnabled(hostId.toInt(), enabled)
  }

  override fun applyMvcpShift(hostId: Double, deltaDp: Double) {
    if (!hostId.isFinite() || hostId <= 0 || !deltaDp.isFinite() || deltaDp == 0.0) return
    NativeHostManager.applyMvcpShift(hostId.toInt(), deltaDp)
  }

  override fun notifyDataCommit(hostId: Double, paddingStartDp: Double, mainAxisGapDp: Double) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.notifyDataCommit(
      hostId.toInt(),
      if (paddingStartDp.isFinite()) paddingStartDp else 0.0,
      if (mainAxisGapDp.isFinite()) mainAxisGapDp else 0.0,
    )
  }

  override fun syncNow(hostId: Double) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.syncNow(hostId.toInt())
  }

  override fun prefetchImages(uris: Array<String>, widthPx: Double, heightPx: Double) {
    val w = if (widthPx.isFinite() && widthPx > 0) widthPx.roundToInt() else 0
    val h = if (heightPx.isFinite() && heightPx > 0) heightPx.roundToInt() else 0
    NitroImagePrefetch.prefetch(uris, w, h)
  }

  override fun cancelImagePrefetch() {
    NitroImagePrefetch.cancelAll()
  }

  override fun attachNativeSlotContainer(
    hostId: Double,
    containerViewTag: Double,
    numColumns: Double,
    crossAxisGapDp: Double,
  ) {
    if (!hostId.isFinite() || hostId <= 0 || !containerViewTag.isFinite() || containerViewTag <= 0) return
    val cols = if (numColumns.isFinite() && numColumns >= 1.0) numColumns.toInt() else 1
    val gap = if (crossAxisGapDp.isFinite() && crossAxisGapDp >= 0.0) crossAxisGapDp else 0.0
    NativeHostManager.attachNativeSlotContainer(hostId.toInt(), containerViewTag.toInt(), cols, gap)
  }

  override fun setNativeTemplateSchema(hostId: Double, schemaJson: String) {
    if (!hostId.isFinite() || hostId <= 0 || schemaJson.isEmpty()) return
    NativeHostManager.setNativeTemplateSchema(hostId.toInt(), schemaJson)
  }

  override fun setNativeTemplateData(
    hostId: Double,
    startIndex: Double,
    count: Double,
    totalCount: Double,
    reset: Boolean,
    packedData: ArrayBuffer,
  ) {
    if (!hostId.isFinite() || hostId <= 0 || !startIndex.isFinite() || !count.isFinite() || !totalCount.isFinite()) return
    val s = startIndex.toInt()
    val c = count.toInt()
    val t = totalCount.toInt()
    if (s < 0 || c <= 0 || t <= 0) return
    NativeHostManager.setNativeTemplateData(hostId.toInt(), s, c, t, reset, packedData)
  }

  override fun shiftNativeTemplateData(hostId: Double, delta: Double, totalCount: Double) {
    if (!hostId.isFinite() || hostId <= 0 || !delta.isFinite() || !totalCount.isFinite()) return
    val d = delta.toInt()
    val t = totalCount.toInt()
    if (d == 0 || t < 0) return
    NativeHostManager.shiftNativeTemplateData(hostId.toInt(), d, t)
  }

  override fun setNativePressHandler(
    hostId: Double,
    onPress: (index: Double, action: String) -> Unit,
  ) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.setNativePressHandler(hostId.toInt(), onPress)
  }

  override fun setNativeDataRequestHandler(
    hostId: Double,
    onRequestData: (startIndex: Double, count: Double) -> Unit,
  ) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.setNativeDataRequestHandler(hostId.toInt(), onRequestData)
  }

  override fun clearNativeTemplate(hostId: Double) {
    if (!hostId.isFinite() || hostId <= 0) return
    NativeHostManager.clearNativeTemplate(hostId.toInt())
  }
}

@OptIn(UnstableReactNativeAPI::class)
private object NativeHostManager {
  private const val SILENT_THROTTLE_MS = 1_000_000_000
  private const val FLING_PACING_VELOCITY_DP_S = 25000.0
  private const val SUPERSONIC_STEP_VIEWPORTS = 2.0
  private const val MAX_DIRECT_TRANSLATION_PX = 2_000_000.0
  private const val SEGMENT_SHIFT_PX = 1_000_000
  private const val INITIAL_SLOT_CAP = 128
  private const val FLAG_ACTIVE = 1
  private const val FLAG_CREATED = 2
  private const val FLAG_ITEM_CHANGED = 4

  private val nextHostId = AtomicInteger(1)
  private val hosts = ConcurrentHashMap<Int, HostSession>()

  private class SlotBinding(
    val viewTag: Int,
    var view: WeakReference<View>? = null,
    var layoutListener: View.OnLayoutChangeListener? = null,
    var lastMeasuredGen: Int = -1,
    var lastMeasuredPx: Int = -1,
    var appliedGen: Int = -1,
    var appliedTargetPx: Double = Double.NaN,
    var appliedVisible: Int = -1,
  )

  private class HostSession(
    val id: Int,
    val engineId: Long,
    val scrollViewTag: Int,
    var stickyViewTag: Int,
    val horizontal: Boolean,
    var userHasOnScroll: Boolean,
    val onSlotRebinds: (Double, Double, Double, Double, Double, Double, Double, ArrayBuffer) -> Unit,
    val onContentSize: (Double, Double) -> Unit,
  ) {
    @Volatile var detached = false
    @Volatile var mvcpEnabled = false
    @Volatile var hasPendingMountWork = true
    var scrollView: WeakReference<View>? = null
    var contentView: WeakReference<View>? = null
    var stickyView: WeakReference<View>? = null
    var uiManager: UIManager? = null
    var uiManagerListener: UIManagerListener? = null
    var svLayoutListener: View.OnLayoutChangeListener? = null
    var contentLayoutListener: View.OnLayoutChangeListener? = null
    var overScroller: OverScroller? = null
    var overScrollerResolved = false
    var originalThrottle: Int? = null
    var preDrawAttached = false
    var attachRetryScheduled = false
    var attachRetryAttempts = 0
    var pacingScheduled = false
    var inMomentum = false
    var inPreDraw = false
    var suppressVelocityUpdate = false
    var preDrawDirty = true
    var transformsDirty = true
    var cachedSlotCount = 0
    var pendingAwaitingGenCount = 0
    var pendingContentSize = false
    var pendingContentSizeTotal = 0.0
    var pendingContentSizeVersion = 0
    var mvcpMomentumShiftPx = 0.0
    var lastOffsetDp = 0.0
    var lastScrollTimeMs = -1L
    var lastVelocityDpS = 0.0
    var lastFrameTimeNs = 0L
    var lastFrameDurationMs = 8.0
    var jsWakeSentMs = 0L
    var jsLatencyMs = 8.0
    var lastReportedTotalSize = -1.0
    var lastReportedVersion = -1
    var lastStickyIndex = -1

    // Coalesced pending slot registrations (JSI thread -> UI thread, 0 per-slot allocations)
    private val regLock = Any()
    private var pendingRegSlots = IntArray(32)
    private var pendingRegTags = IntArray(32)
    private var pendingRegCount = 0
    private var regFlushScheduled = false
    private var drainSlotsScratch = IntArray(32)
    private var drainTagsScratch = IntArray(32)

    // Direct O(1) indexed slot table (eliminates SparseArray binary search + boxing in Nterp)
    var slotArray = arrayOfNulls<SlotBinding>(INITIAL_SLOT_CAP)
    var maxSlotIndex = -1

    // Level 3: Pure-native declarative template renderer (zero JS during scroll!)
    val templateEngine = NativeTemplateEngine()
    var templateLoadNotified = false
    var templateReportedContainerDp = 0.0
    var templateInfoBuf = IntArray(INITIAL_SLOT_CAP * 6)

    // Reusable zero-allocation UI-thread scratch buffers
    val scrollHeader = DoubleArray(10)
    var deltasBuf = IntArray(INITIAL_SLOT_CAP * 4)
    val sizeHeader = DoubleArray(6)
    var sizeIdsBuf = IntArray(INITIAL_SLOT_CAP)
    var sizeValsBuf = DoubleArray(INITIAL_SLOT_CAP)
    var sizeGensBuf = IntArray(INITIAL_SLOT_CAP)
    val transHeader = DoubleArray(4)
    var offsetsBuf = DoubleArray(INITIAL_SLOT_CAP)
    var metaBuf = IntArray(INITIAL_SLOT_CAP * 3)
    var seenGenScratch = IntArray(INITIAL_SLOT_CAP)

    fun ensureSlotCapacity(needed: Int) {
      if (needed <= offsetsBuf.size && needed <= slotArray.size) return
      var next = maxOf(offsetsBuf.size, slotArray.size)
      while (next < needed) next *= 2
      if (next > slotArray.size) {
        slotArray = slotArray.copyOf(next)
      }
      if (next > offsetsBuf.size) {
        offsetsBuf = DoubleArray(next)
        metaBuf = IntArray(next * 3)
        templateInfoBuf = IntArray(next * 6)
        deltasBuf = IntArray(next * 4)
        sizeIdsBuf = IntArray(next)
        sizeValsBuf = DoubleArray(next)
        sizeGensBuf = IntArray(next)
        seenGenScratch = IntArray(next)
      }
    }

    fun attachSlotViewListener(binding: SlotBinding, view: View) {
      if (binding.layoutListener != null) return
      val listener = View.OnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
        if (detached) return@OnLayoutChangeListener
        if ((bottom - top) != (oldBottom - oldTop) ||
          (right - left) != (oldRight - oldLeft) ||
          top != oldTop ||
          left != oldLeft
        ) {
          binding.appliedTargetPx = Double.NaN
          preDrawDirty = true
          // Position and measure immediately during performLayout() BEFORE dispatchOnPreDraw()!
          if (!inPreDraw) {
            runPreDraw(fromLayout = true)
          }
        }
      }
      binding.layoutListener = listener
      view.addOnLayoutChangeListener(listener)
    }

    fun enqueueRegistration(slotId: Int, viewTag: Int) {
      val shouldSchedule: Boolean
      synchronized(regLock) {
        if (pendingRegCount >= pendingRegSlots.size) {
          val next = pendingRegSlots.size * 2
          pendingRegSlots = pendingRegSlots.copyOf(next)
          pendingRegTags = pendingRegTags.copyOf(next)
        }
        pendingRegSlots[pendingRegCount] = slotId
        pendingRegTags[pendingRegCount] = viewTag
        pendingRegCount++
        hasPendingMountWork = true
        shouldSchedule = !regFlushScheduled
        if (shouldSchedule) regFlushScheduled = true
      }
      if (shouldSchedule) {
        UiThreadUtil.runOnUiThread {
          if (detached) return@runOnUiThread
          if (!preDrawAttached) {
            attachUiListeners()
          }
          drainPendingRegistrations()
          runPreDraw(fromLayout = false)
        }
      }
    }

    fun drainPendingRegistrations(): Boolean {
      var count: Int
      synchronized(regLock) {
        count = pendingRegCount
        if (count > 0) {
          if (drainSlotsScratch.size < count) {
            drainSlotsScratch = IntArray(count)
            drainTagsScratch = IntArray(count)
          }
          System.arraycopy(pendingRegSlots, 0, drainSlotsScratch, 0, count)
          System.arraycopy(pendingRegTags, 0, drainTagsScratch, 0, count)
          pendingRegCount = 0
        }
        regFlushScheduled = false
      }
      var anyUnresolved = false
      for (i in 0 until count) {
        val slotId = drainSlotsScratch[i]
        val viewTag = drainTagsScratch[i]
        val existing = getSlotBinding(slotId)
        if (existing != null && existing.viewTag == viewTag && existing.view?.get() != null) {
          continue
        }
        val resolved = resolveViewByTag(viewTag)
        putSlotBinding(slotId, SlotBinding(viewTag, resolved?.let { WeakReference(it) }))
        if (resolved == null) anyUnresolved = true
      }
      if (hasPendingMountWork) {
        for (i in 0..maxSlotIndex) {
          val b = slotArray[i] ?: continue
          if (b.view?.get() == null) {
            val resolved = resolveViewByTag(b.viewTag)
            if (resolved != null) {
              b.view = WeakReference(resolved)
              attachSlotViewListener(b, resolved)
              preDrawDirty = true
              transformsDirty = true
            } else {
              anyUnresolved = true
            }
          }
        }
        synchronized(regLock) {
          if (!anyUnresolved && pendingRegCount == 0 && preDrawAttached) {
            hasPendingMountWork = false
          }
        }
      }
      return count > 0
    }

    fun detachSlotBinding(binding: SlotBinding) {
      val v = binding.view?.get()
      val listener = binding.layoutListener
      if (v != null && listener != null) {
        v.removeOnLayoutChangeListener(listener)
      }
      binding.layoutListener = null
    }

    fun getSlotBinding(slotId: Int): SlotBinding? {
      return if (slotId in 0 until slotArray.size) slotArray[slotId] else null
    }

    fun putSlotBinding(slotId: Int, binding: SlotBinding) {
      ensureSlotCapacity(slotId + 16)
      slotArray[slotId]?.let { detachSlotBinding(it) }
      slotArray[slotId] = binding
      if (slotId > maxSlotIndex) maxSlotIndex = slotId
      binding.view?.get()?.let { attachSlotViewListener(binding, it) }
      preDrawDirty = true
      transformsDirty = true
    }

    fun removeSlotBinding(slotId: Int) {
      if (slotId in 0 until slotArray.size) {
        slotArray[slotId]?.let { detachSlotBinding(it) }
        slotArray[slotId] = null
      }
    }

    val scrollListener = View.OnScrollChangeListener { v, scrollX, scrollY, _, _ ->
      if (detached) return@OnScrollChangeListener
      handleScrollChange(v, scrollX, scrollY)
    }

    val preDrawListener = ViewTreeObserver.OnPreDrawListener {
      if (!detached) {
        runPreDraw(fromLayout = false)
      }
      true
    }

    val attachRetryCallback = Choreographer.FrameCallback {
      attachRetryScheduled = false
      if (!detached && !preDrawAttached) {
        attachUiListeners()
      }
    }

    val pacingCallback = Choreographer.FrameCallback { frameTimeNanos ->
      pacingScheduled = false
      if (detached) return@FrameCallback
      if (lastFrameTimeNs > 0L) {
        lastFrameDurationMs = (frameTimeNanos - lastFrameTimeNs) / 1_000_000.0
      }
      lastFrameTimeNs = frameTimeNanos
      val sv = resolveScrollView() ?: return@FrameCallback
      handleScrollChange(sv, sv.scrollX, sv.scrollY)
    }

    fun resolveViewByTag(tag: Int): View? {
      if (tag <= 0) return null
      val context = NitroModules.applicationContext ?: return null
      val manager = UIManagerHelper.getUIManagerForReactTag(context, tag) ?: return null
      return try {
        manager.resolveView(tag)
      } catch (_: IllegalViewOperationException) {
        null
      }
    }

    fun resolveScrollView(): View? {
      scrollView?.get()?.let { return it }
      val v = resolveViewByTag(scrollViewTag) ?: return null
      scrollView = WeakReference(v)
      return v
    }

    fun resolveStickyView(): View? {
      if (stickyViewTag <= 0) return null
      stickyView?.get()?.let { return it }
      val v = resolveViewByTag(stickyViewTag) ?: return null
      stickyView = WeakReference(v)
      return v
    }

    fun applyThrottlePolicy(view: View) {
      val target = view as? ReactScrollViewHelper.HasScrollEventThrottle ?: return
      if (!userHasOnScroll) {
        if (originalThrottle == null) {
          originalThrottle = target.scrollEventThrottle
        }
        target.scrollEventThrottle = SILENT_THROTTLE_MS
      } else {
        originalThrottle?.let { orig ->
          target.scrollEventThrottle = orig
          originalThrottle = null
        }
      }
    }

    private fun ensureUiManagerListener() {
      if (uiManagerListener != null || detached) return
      val context = NitroModules.applicationContext ?: return
      val manager = UIManagerHelper.getUIManagerForReactTag(context, scrollViewTag) ?: return
      val listener = object : UIManagerListener {
        override fun willDispatchViewUpdates(uiManager: UIManager) {}
        override fun willMountItems(uiManager: UIManager) {}
        override fun didScheduleMountItems(uiManager: UIManager) {}
        override fun didDispatchMountItems(uiManager: UIManager) {}
        override fun didMountItems(uiManager: UIManager) {
          if (detached || (preDrawAttached && !hasPendingMountWork)) return
          if (!preDrawAttached) {
            attachUiListeners()
          }
          drainPendingRegistrations()
          if (preDrawDirty && !inPreDraw) {
            runPreDraw(fromLayout = true)
          }
        }
      }
      try {
        manager.addUIManagerEventListener(listener)
        uiManager = manager
        uiManagerListener = listener
      } catch (_: Throwable) {
        // Fallback to Choreographer retry + PreDraw listener
      }
    }

    private fun attachContentLayoutListener(sv: View) {
      val vg = sv as? ViewGroup ?: return
      if (vg.childCount == 0) return
      val child = vg.getChildAt(0) ?: return
      if (contentView?.get() === child) return
      contentView?.get()?.let { prev -> contentLayoutListener?.let { prev.removeOnLayoutChangeListener(it) } }
      val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        if (detached) return@OnLayoutChangeListener
        if (hasPendingMountWork) drainPendingRegistrations()
        if ((preDrawDirty || pendingAwaitingGenCount > 0) && !inPreDraw) {
          runPreDraw(fromLayout = true)
        }
      }
      contentView = WeakReference(child)
      contentLayoutListener = listener
      child.addOnLayoutChangeListener(listener)
    }

    fun attachUiListeners() {
      if (detached || preDrawAttached) return
      ensureUiManagerListener()
      val sv = resolveScrollView()
      if (sv == null) {
        if (!attachRetryScheduled && attachRetryAttempts < 12) {
          attachRetryAttempts++
          attachRetryScheduled = true
          Choreographer.getInstance().postFrameCallback(attachRetryCallback)
        }
        return
      }
      applyThrottlePolicy(sv)
      sv.setOnScrollChangeListener(scrollListener)
      if (svLayoutListener == null) {
        val listener = View.OnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
          if (detached) return@OnLayoutChangeListener
          attachContentLayoutListener(v)
          if (hasPendingMountWork) drainPendingRegistrations()
          if (templateEngine.isActive && !templateLoadNotified && v.width > 0 && v.height > 0 && !inPreDraw) {
            handleScrollChange(v, v.scrollX, v.scrollY)
          }
          if ((preDrawDirty || pendingAwaitingGenCount > 0) && !inPreDraw) {
            runPreDraw(fromLayout = true)
          }
        }
        svLayoutListener = listener
        sv.addOnLayoutChangeListener(listener)
      }
      attachContentLayoutListener(sv)
      if (sv.viewTreeObserver.isAlive) {
        sv.viewTreeObserver.addOnPreDrawListener(preDrawListener)
        preDrawAttached = true
      }
      preDrawDirty = true
      transformsDirty = true
      drainPendingRegistrations()
      // If JS already reconciled the initial Frame 1 batch synchronously, skip handleScrollChange
      // here so unmeasured FIRST_PAINT_ITEMS can measure during performLayout() before refill!
      val existingSlots = NativeHostBridge.nativeReadTransforms(
        engineId = engineId,
        outOffsetsDp = offsetsBuf,
        outMeta = metaBuf,
        maxSlots = offsetsBuf.size,
        outHeader = transHeader,
      )
      cachedSlotCount = existingSlots
      transformsDirty = false
      if (existingSlots <= 0) {
        handleScrollChange(sv, sv.scrollX, sv.scrollY)
      }
      runPreDraw(fromLayout = true)
    }

    fun detachUiListeners() {
      uiManagerListener?.let { listener ->
        try {
          uiManager?.removeUIManagerEventListener(listener)
        } catch (_: Throwable) {}
      }
      uiManagerListener = null
      uiManager = null
      if (attachRetryScheduled) {
        Choreographer.getInstance().removeFrameCallback(attachRetryCallback)
        attachRetryScheduled = false
      }
      contentView?.get()?.let { cv ->
        contentLayoutListener?.let { cv.removeOnLayoutChangeListener(it) }
      }
      contentLayoutListener = null
      contentView = null
      val sv = scrollView?.get()
      if (sv != null) {
        sv.setOnScrollChangeListener(null)
        svLayoutListener?.let { sv.removeOnLayoutChangeListener(it) }
        originalThrottle?.let { orig ->
          (sv as? ReactScrollViewHelper.HasScrollEventThrottle)?.scrollEventThrottle = orig
          originalThrottle = null
        }
        if (preDrawAttached && sv.viewTreeObserver.isAlive) {
          sv.viewTreeObserver.removeOnPreDrawListener(preDrawListener)
        }
      }
      svLayoutListener = null
      preDrawAttached = false
      if (pacingScheduled) {
        Choreographer.getInstance().removeFrameCallback(pacingCallback)
        pacingScheduled = false
      }
      for (i in 0..maxSlotIndex) {
        slotArray[i]?.let { detachSlotBinding(it) }
        slotArray[i] = null
      }
      maxSlotIndex = -1
      templateEngine.clear()
      scrollView = null
      stickyView = null
    }

    private fun resolveOverScroller(sv: View): OverScroller? {
      if (overScrollerResolved) return overScroller
      overScrollerResolved = true
      overScroller = try {
        val clazz = when (sv) {
          is ScrollView -> ScrollView::class.java
          is HorizontalScrollView -> HorizontalScrollView::class.java
          else -> null
        }
        clazz?.getDeclaredField("mScroller")?.let { field ->
          field.isAccessible = true
          field.get(sv) as? OverScroller
        }
      } catch (_: Throwable) {
        null
      }
      return overScroller
    }

    private fun detectMomentum(sv: View): Boolean {
      val scroller = resolveOverScroller(sv)
      if (scroller != null && !scroller.isFinished) return true
      return when (sv) {
        is ReactScrollView -> sv.getFlingAnimator().isRunning
        is ReactHorizontalScrollView -> sv.getFlingAnimator().isRunning
        else -> false
      }
    }

    private fun performMvcpScrollTo(sv: View, newScrollPx: Int, density: Double) {
      val clampedPx = maxOf(0, newScrollPx)
      lastOffsetDp = clampedPx.toDouble() / density
      suppressVelocityUpdate = true
      try {
        if (horizontal) {
          sv.scrollTo(clampedPx, sv.scrollY)
        } else {
          sv.scrollTo(sv.scrollX, clampedPx)
        }
      } finally {
        suppressVelocityUpdate = false
      }
    }

    fun handleScrollChange(sv: View, scrollX: Int, scrollY: Int) {
      val density = PixelUtil.getDisplayMetricDensity().toDouble()
      if (density <= 0.0) return
      val offsetPx = if (horizontal) scrollX else scrollY
      val offsetDp = offsetPx.toDouble() / density
      val nowMs = SystemClock.uptimeMillis()
      val stepDp = if (lastScrollTimeMs >= 0L) abs(offsetDp - lastOffsetDp) else 0.0
      val vpDp = (if (horizontal) sv.width else sv.height).toDouble() / density
      val nowMomentum = detectMomentum(sv)
      if (!suppressVelocityUpdate) {
        if (!nowMomentum && vpDp > 0.0 && stepDp > vpDp * 1.5) {
          // Programmatic instant jump (scrollToIndex / scrollToOffset): never treat as fling velocity!
          lastVelocityDpS = 0.0
        } else if (lastScrollTimeMs >= 0L) {
          val dt = nowMs - lastScrollTimeMs
          if (dt in 1..200) {
            lastVelocityDpS = ((offsetDp - lastOffsetDp) / dt.toDouble()) * 1000.0
          } else if (dt > 200) {
            lastVelocityDpS = 0.0
          }
        }
        lastOffsetDp = offsetDp
        lastScrollTimeMs = nowMs
      }

      if (inMomentum && !nowMomentum) {
        // Momentum just settled — fold any accumulated MVCP momentum shift atomically.
        foldMomentumMvcpShift(sv, density)
        NativeHostBridge.nativeOnMomentumEnd(engineId, (if (horizontal) sv.scrollX else sv.scrollY) / density)
      }
      inMomentum = nowMomentum

      // Supersonic animated jump guard (>2 viewports per single scroll step during momentum,
      // e.g. 100k animated return flight): immune to 1ms clock jitter on normal 14,000 dp/s flings!
      if (inMomentum && vpDp > 0.0 && stepDp > vpDp * SUPERSONIC_STEP_VIEWPORTS) {
        return
      }

      // Include accumulated momentum MVCP shift so C++ engaged range tracks the EXACT visual viewport!
      val effectiveOffsetDp = ((if (horizontal) sv.scrollX else sv.scrollY).toDouble() + mvcpMomentumShiftPx) / density

      // Level 2: Frame-budgeted pacing only during extreme flings (> 25,000 dp/s)
      val budgetSlots = if (abs(lastVelocityDpS) > FLING_PACING_VELOCITY_DP_S) {
        if (lastFrameDurationMs > 18.0) 6 else 10
      } else {
        0
      }

      val inflightJsMs = if (jsWakeSentMs > 0L) (nowMs - jsWakeSentMs).coerceAtLeast(0L).toDouble() else 0.0
      val effectiveJsLatencyMs = if (templateEngine.isActive) -1.0 else maxOf(jsLatencyMs, inflightJsMs)

      val deltaCount = NativeHostBridge.nativeOnScroll(
        engineId = engineId,
        absoluteOffsetDp = effectiveOffsetDp,
        velocityDpS = lastVelocityDpS,
        budgetSlots = budgetSlots,
        captureAnchor = !inMomentum,
        jsLatencyMs = effectiveJsLatencyMs,
        outHeader = scrollHeader,
        outDeltas = deltasBuf,
      )
      if (deltaCount < 0) return

      val slotCount = scrollHeader[1].toInt()
      ensureSlotCapacity(maxOf(slotCount + 16, deltaCount + 16))
      val rangeStart = scrollHeader[2].toInt()
      val rangeEnd = scrollHeader[3].toInt()
      val layoutVersion = scrollHeader[4].toInt()
      val totalSizeDp = scrollHeader[5]
      val stickyIndex = scrollHeader[6].toInt()
      val stickyTranslateDp = scrollHeader[7]
      val hasMore = scrollHeader[8] != 0.0
      val changed = scrollHeader[9] != 0.0

      if (deltaCount > 0 || changed) {
        preDrawDirty = true
        transformsDirty = true
      }

      // Immediately position sticky header overlay on UI thread (0.0 dp lag!)
      applyStickyTransform(stickyIndex, stickyTranslateDp, density)

      // Level 3: Pure-native declarative template path — bind, measure, MVCP, and position ALL
      // slots synchronously on UI thread BEFORE performDraw with ZERO JS wakeups!
      if (templateEngine.isActive) {
        val stickyChanged = stickyIndex != lastStickyIndex
        lastStickyIndex = stickyIndex
        if (deltaCount > 0 || changed || transformsDirty || !templateLoadNotified || abs(mvcpMomentumShiftPx) >= 0.5) {
          runTemplateSync(sv, density, offsetDp, vpDp, fromLayout = false)
        }
        if (stickyChanged) {
          val emptyBuf = ArrayBuffer.allocate(4)
          onSlotRebinds(
            0.0,
            rangeStart.toDouble(),
            rangeEnd.toDouble(),
            layoutVersion.toDouble(),
            totalSizeDp,
            stickyIndex.toDouble(),
            lastVelocityDpS,
            emptyBuf,
          )
        }
        if (hasMore && !pacingScheduled) {
          pacingScheduled = true
          Choreographer.getInstance().postFrameCallback(pacingCallback)
        }
        return
      }

      // Check if JS actually needs to wake up:
      // Wake JS ONLY if a slot was created/rebound, stickyIndex changed, or range/version changed.
      var needsJsWake = stickyIndex != lastStickyIndex || changed
      if (!needsJsWake && deltaCount > 0) {
        for (k in 0 until deltaCount) {
          val flags = deltasBuf[k * 4 + 3]
          if ((flags and (FLAG_CREATED or FLAG_ITEM_CHANGED)) != 0) {
            needsJsWake = true
            break
          }
        }
      }
      lastStickyIndex = stickyIndex

      if (needsJsWake) {
        if (deltaCount > 0 && jsWakeSentMs == 0L) {
          jsWakeSentMs = SystemClock.uptimeMillis()
        }
        val buf = ArrayBuffer.allocate(maxOf(4, deltaCount * 16))
        if (deltaCount > 0) {
          val bb = buf.getBuffer(false)
          bb.order(ByteOrder.nativeOrder())
          val ib = bb.asIntBuffer()
          ib.put(deltasBuf, 0, deltaCount * 4)
        }
        lastReportedTotalSize = totalSizeDp
        lastReportedVersion = layoutVersion
        onSlotRebinds(
          slotCount.toDouble(),
          rangeStart.toDouble(),
          rangeEnd.toDouble(),
          layoutVersion.toDouble(),
          totalSizeDp,
          stickyIndex.toDouble(),
          lastVelocityDpS,
          buf,
        )
      }

      if (hasMore && !pacingScheduled) {
        pacingScheduled = true
        Choreographer.getInstance().postFrameCallback(pacingCallback)
      }
    }

    private fun maxScrollPxOf(sv: View): Int {
      val vg = sv as? android.view.ViewGroup ?: return Int.MAX_VALUE
      if (vg.childCount == 0) return 0
      val child = vg.getChildAt(0)
      return if (horizontal) maxOf(0, child.width - sv.width) else maxOf(0, child.height - sv.height)
    }

    fun foldMomentumMvcpShift(sv: View, density: Double) {
      if (abs(mvcpMomentumShiftPx) < 0.5) {
        mvcpMomentumShiftPx = 0.0
        return
      }
      val deltaPx = mvcpMomentumShiftPx.roundToInt()
      if (deltaPx == 0) {
        mvcpMomentumShiftPx = 0.0
        return
      }
      val cur = if (horizontal) sv.scrollX else sv.scrollY
      val desired = maxOf(0, cur + deltaPx)
      val maxScroll = maxScrollPxOf(sv)
      if (desired > maxScroll) {
        // ContentView hasn't finished growing in Fabric yet (e.g. prepend). Keep pinned via
        // -mvcpMomentumShiftPx and fold atomically on the next PreDraw once ContentView grows!
        return
      }
      mvcpMomentumShiftPx = 0.0
      preDrawDirty = true
      transformsDirty = true
      // Invalidate cached appliedTargetPx on all slots so awaiting slots are never left visible
      // at pre-fold coordinates over the newly shifted scroll viewport!
      for (i in 0..maxSlotIndex) {
        val b = slotArray[i] ?: continue
        b.appliedTargetPx = Double.NaN
      }
      templateEngine.invalidateAppliedCoords()
      performMvcpScrollTo(sv, desired, density)
    }

    fun runTemplateSync(
      sv: View,
      density: Double,
      offsetDp: Double,
      vpDp: Double,
      fromLayout: Boolean,
    ) {
      if (!templateEngine.isActive || detached) return
      val res = templateEngine.syncAndPositionSlots(
        engineId = engineId,
        sv = sv,
        resolveContainer = { tag -> resolveViewByTag(tag) as? ViewGroup },
        horizontal = horizontal,
        mvcpEnabled = mvcpEnabled,
        inMomentum = inMomentum,
        suppressDataRequest = inMomentum && abs(lastVelocityDpS) > 18000.0,
        density = density,
        mvcpMomentumShiftPx = mvcpMomentumShiftPx,
        offsetsBuf = offsetsBuf,
        infoBuf = templateInfoBuf,
        transHeader = transHeader,
        sizeIdsBuf = sizeIdsBuf,
        sizeValsBuf = sizeValsBuf,
        sizeGensBuf = sizeGensBuf,
        sizeHeader = sizeHeader,
        onApplyMvcpDelta = { mvcpDeltaDp ->
          val deltaPx = mvcpDeltaDp * density
          if (inMomentum) {
            mvcpMomentumShiftPx += deltaPx
          } else {
            val shiftInt = deltaPx.roundToInt()
            if (shiftInt != 0) {
              val cur = if (horizontal) sv.scrollX else sv.scrollY
              performMvcpScrollTo(sv, cur + shiftInt, density)
            }
          }
          mvcpMomentumShiftPx
        },
        onDrainedMvcpShift = {
          applyDrainedMvcpShift(sv, density)
          mvcpMomentumShiftPx
        },
      )
      if (res.slotCount > 0) {
        applyStickyTransform(res.stickyIndex, res.stickyTranslateDp, density)
        val total = res.totalSizeDp
        // Keep JS completely silent during mid-list scrolling: notify JS onContentSize ONLY on
        // first mount (so onLoad fires), when total exceeds container headroom, or near list end!
        val nearEnd = vpDp > 0.0 && (offsetDp + vpDp * 3.0) >= minOf(templateReportedContainerDp, total)
        val needsReport =
          !templateLoadNotified ||
          total > templateReportedContainerDp ||
          (nearEnd && abs(total - templateReportedContainerDp) > 0.5)
        if (needsReport && total > 0.0) {
          val nextReported = if (!templateLoadNotified || nearEnd || templateReportedContainerDp <= 0.0) {
            total
          } else {
            total + maxOf(vpDp * 2.0, total * 0.1)
          }
          templateLoadNotified = true
          templateReportedContainerDp = nextReported
          lastReportedTotalSize = nextReported
          val ver = if (res.layoutVersion >= 0) res.layoutVersion else lastReportedVersion + 1
          lastReportedVersion = ver
          if (fromLayout) {
            pendingContentSize = true
            pendingContentSizeTotal = nextReported
            pendingContentSizeVersion = ver
          } else {
            pendingContentSize = false
            onContentSize(nextReported, ver.toDouble())
          }
        }
        preDrawDirty = false
        transformsDirty = false
      }
    }

    private fun applyDrainedMvcpShift(sv: View, density: Double) {
      val drainedDp = transHeader[3]
      transHeader[3] = 0.0
      if (abs(drainedDp) > 0.1) {
        mvcpMomentumShiftPx += drainedDp * density
        inMomentum = detectMomentum(sv)
        if (!inMomentum) {
          foldMomentumMvcpShift(sv, density)
        }
      }
    }

    fun applyExternalMvcpShift(deltaDp: Double) {
      val sv = resolveScrollView() ?: return
      val density = PixelUtil.getDisplayMetricDensity().toDouble()
      if (density <= 0.0) return
      mvcpMomentumShiftPx += deltaDp * density
      preDrawDirty = true
      transformsDirty = true
      inMomentum = detectMomentum(sv)
      if (!inMomentum) {
        foldMomentumMvcpShift(sv, density)
      }
      runPreDraw()
    }

    private fun applyStickyTransform(stickyIndex: Int, stickyTranslateDp: Double, density: Double) {
      val sticky = resolveStickyView() ?: return
      if (stickyIndex < 0) {
        if (sticky.visibility != View.INVISIBLE) sticky.visibility = View.INVISIBLE
        return
      }
      val px = (stickyTranslateDp * density).toFloat()
      if (horizontal) {
        if (sticky.translationX != px) sticky.translationX = px
      } else {
        if (sticky.translationY != px) sticky.translationY = px
      }
      if (sticky.visibility != View.VISIBLE) sticky.visibility = View.VISIBLE
    }

    private fun parseGenerationTag(view: View): Int {
      val raw = view.getTag(R.id.view_tag_native_id) as? String ?: return 0
      // Format: "nl:<gen>" (fast zero-allocation integer parse)
      val len = raw.length
      if (len < 4 || raw[0] != 'n' || raw[1] != 'l' || raw[2] != ':') return 0
      var acc = 0
      for (i in 3 until len) {
        val c = raw[i]
        if (c < '0' || c > '9') return 0
        acc = acc * 10 + (c - '0')
      }
      return acc
    }

    fun runPreDraw(fromLayout: Boolean = false) {
      if (inPreDraw || detached) return
      val sv = resolveScrollView() ?: return
      inPreDraw = true
      try {
        if (hasPendingMountWork) {
          drainPendingRegistrations()
        }

        // Only check momentum completion on PreDraw if we were in momentum.
        if (inMomentum && !detectMomentum(sv)) {
          val density = PixelUtil.getDisplayMetricDensity().toDouble()
          if (density > 0.0) {
            foldMomentumMvcpShift(sv, density)
            NativeHostBridge.nativeOnMomentumEnd(engineId, (if (horizontal) sv.scrollX else sv.scrollY) / density)
          }
          inMomentum = false
        } else if (!inMomentum && abs(mvcpMomentumShiftPx) >= 0.5) {
          val density = PixelUtil.getDisplayMetricDensity().toDouble()
          if (density > 0.0) {
            foldMomentumMvcpShift(sv, density)
          }
        }

        // Flush any coalesced content size update from performLayout() once per frame in PreDraw.
        if (!fromLayout && pendingContentSize) {
          pendingContentSize = false
          val total = pendingContentSizeTotal
          val ver = pendingContentSizeVersion
          if (abs(total - lastReportedTotalSize) > 0.5 || ver != lastReportedVersion) {
            lastReportedTotalSize = total
            lastReportedVersion = ver
            onContentSize(total, ver.toDouble())
          }
        }

        // Fast-path exit on steady scroll frames: 0 JNI calls, 0 loops, 0 getTag()!
        if (!preDrawDirty && pendingAwaitingGenCount == 0) {
          return
        }

        val density = PixelUtil.getDisplayMetricDensity().toDouble()
        if (density <= 0.0) return

        // Level 3: Pure-native declarative templates render/measure/position synchronously on UI thread!
        if (templateEngine.isActive) {
          val offsetDp = (if (horizontal) sv.scrollX else sv.scrollY).toDouble() / density
          val vpDp = (if (horizontal) sv.width else sv.height).toDouble() / density
          runTemplateSync(sv, density, offsetDp, vpDp, fromLayout)
          return
        }

        val capacity = maxOf(offsetsBuf.size, maxSlotIndex + 16)
        ensureSlotCapacity(capacity)

        val fullPass = preDrawDirty || transformsDirty
        var slotCount = cachedSlotCount
        if (transformsDirty || slotCount == 0) {
          slotCount = NativeHostBridge.nativeReadTransforms(
            engineId = engineId,
            outOffsetsDp = offsetsBuf,
            outMeta = metaBuf,
            maxSlots = offsetsBuf.size,
            outHeader = transHeader,
          )
          if (slotCount > offsetsBuf.size) {
            ensureSlotCapacity(slotCount + 16)
            val savedPending = transHeader[3]
            slotCount = NativeHostBridge.nativeReadTransforms(
              engineId, offsetsBuf, metaBuf, offsetsBuf.size, transHeader,
            )
            transHeader[3] += savedPending
          }
          cachedSlotCount = slotCount
          transformsDirty = false
          applyDrainedMvcpShift(sv, density)
        }

        // Step 1: Collect measured slot sizes on UI thread BEFORE draw (zero JS onLayout round-trip!)
        // When fullPass == false (only awaiting Fabric commit of a few rebound slots), inspect ONLY
        // the slots whose appliedGen != expectedGen — 0 JNI reads, 0 loops over settled slots!
        var measuredCount = 0
        var newlyReadyCount = 0
        for (s in 0 until slotCount) {
          val active = (metaBuf[s * 3] and 1) != 0
          if (!active) {
            seenGenScratch[s] = 0
            continue
          }
          val binding = getSlotBinding(s)
          if (binding == null) {
            seenGenScratch[s] = -1
            continue
          }
          val expectedGen = metaBuf[s * 3 + 1]
          if (!fullPass && binding.appliedGen == expectedGen) {
            seenGenScratch[s] = expectedGen
            continue
          }
          val view = binding.view?.get() ?: resolveViewByTag(binding.viewTag)?.also {
            binding.view = WeakReference(it)
            attachSlotViewListener(binding, it)
          }
          if (view == null) {
            seenGenScratch[s] = -1
            continue
          }
          val seenGen = if (binding.appliedGen == expectedGen) expectedGen else parseGenerationTag(view)
          seenGenScratch[s] = seenGen
          if (seenGen != expectedGen) continue
          if (binding.appliedGen != expectedGen) newlyReadyCount++
          val measures = metaBuf[s * 3 + 2] != 0
          if (!measures) continue
          val measuredPx = if (horizontal) view.width else view.height
          // Key by (seenGen, measuredPx) so recycled items with identical height to the prior item ALWAYS report!
          if (measuredPx > 0 && (seenGen != binding.lastMeasuredGen || measuredPx != binding.lastMeasuredPx)) {
            binding.lastMeasuredGen = seenGen
            binding.lastMeasuredPx = measuredPx
            sizeIdsBuf[measuredCount] = s
            sizeValsBuf[measuredCount] = measuredPx.toDouble() / density
            sizeGensBuf[measuredCount] = seenGen
            measuredCount++
          }
        }

        // Fast exit when we were only polling pending slots and none have mounted yet.
        if (!fullPass && measuredCount == 0 && newlyReadyCount == 0) {
          return
        }

        // Step 2: Apply batch measured sizes in C++ & execute native MVCP BEFORE performDraw!
        var layoutChanged = false
        if (measuredCount > 0) {
          val changed = NativeHostBridge.nativeApplySlotSizes(
            engineId = engineId,
            slotIds = sizeIdsBuf,
            sizesDp = sizeValsBuf,
            seenGens = sizeGensBuf,
            count = measuredCount,
            applyMvcp = mvcpEnabled,
            outHeader = sizeHeader,
          )
          if (changed) {
            layoutChanged = true
            val mvcpDeltaDp = sizeHeader[1]
            val totalSizeDp = sizeHeader[2]
            val layoutVersion = sizeHeader[3].toInt()
            if (mvcpEnabled && abs(mvcpDeltaDp) > 0.1) {
              val deltaPx = mvcpDeltaDp * density
              if (inMomentum) {
                // Preserve OverScroller velocity during momentum; compensated with minus sign below!
                mvcpMomentumShiftPx += deltaPx
              } else {
                val shiftInt = deltaPx.roundToInt()
                if (shiftInt != 0) {
                  val cur = if (horizontal) sv.scrollX else sv.scrollY
                  performMvcpScrollTo(sv, cur + shiftInt, density)
                }
              }
            }
            // Re-read freshly updated exact positions from C++ (~80 ns)
            slotCount = NativeHostBridge.nativeReadTransforms(
              engineId, offsetsBuf, metaBuf, offsetsBuf.size, transHeader,
            )
            cachedSlotCount = slotCount
            applyDrainedMvcpShift(sv, density)
            // Notify JS when totalSizeDp or layoutVersion changed; coalesce during performLayout().
            if (abs(totalSizeDp - lastReportedTotalSize) > 0.5 || layoutVersion != lastReportedVersion) {
              if (fromLayout) {
                pendingContentSize = true
                pendingContentSizeTotal = totalSizeDp
                pendingContentSizeVersion = layoutVersion
              } else {
                pendingContentSize = false
                lastReportedTotalSize = totalSizeDp
                lastReportedVersion = layoutVersion
                onContentSize(totalSizeDp, layoutVersion.toDouble())
              }
            }
          }
        }

        // Step 3: Apply exact post-layout translation & visibility to every slot view BEFORE performDraw!
        val scrollPx = if (horizontal) sv.scrollX.toDouble() else sv.scrollY.toDouble()
        val vpPx = if (horizontal) sv.width.toDouble() else sv.height.toDouble()
        var awaitingCount = 0
        for (s in 0 until slotCount) {
          val binding = getSlotBinding(s)
          val activeMeta = metaBuf[s * 3]
          val active = (activeMeta and 1) != 0
          val inPlaceUpdate = (activeMeta and 2) != 0
          if (binding == null) {
            if (active) awaitingCount++
            continue
          }
          val expectedGen = metaBuf[s * 3 + 1]
          if (!fullPass && !layoutChanged && active && binding.appliedGen == expectedGen && binding.appliedVisible == View.VISIBLE) {
            continue
          }
          val view = binding.view?.get() ?: resolveViewByTag(binding.viewTag)?.also {
            binding.view = WeakReference(it)
            attachSlotViewListener(binding, it)
          }
          if (view == null) {
            if (active) awaitingCount++
            continue
          }
          if (!active) {
            if (binding.appliedVisible != View.INVISIBLE) {
              if (view.visibility != View.INVISIBLE) view.visibility = View.INVISIBLE
              binding.appliedVisible = View.INVISIBLE
            }
            continue
          }
          val seenGen = if (s < seenGenScratch.size && seenGenScratch[s] >= 0) {
            seenGenScratch[s]
          } else {
            parseGenerationTag(view)
          }
          if (seenGen != expectedGen) {
            if (inPlaceUpdate && binding.appliedVisible == View.VISIBLE) {
              val targetPx = offsetsBuf[s] * density - mvcpMomentumShiftPx
              if (binding.appliedTargetPx != targetPx) {
                if (horizontal) {
                  val relPx = (targetPx - view.left).toFloat()
                  if (view.translationX != relPx) view.translationX = relPx
                } else {
                  val relPx = (targetPx - view.top).toFloat()
                  if (view.translationY != relPx) view.translationY = relPx
                }
                binding.appliedTargetPx = targetPx
              }
              awaitingCount++
              continue
            }
            // Awaiting Fabric mount of newly bound item: if the slot's previous position is ALREADY
            // offscreen, keep it VISIBLE at its offscreen translation to avoid invalidating parent
            // DisplayLists (View.setFlags -> invalidateParentCaches). Hide only if onscreen or new!
            val prevPx = binding.appliedTargetPx
            val prevSize = if (horizontal) view.width.toDouble() else view.height.toDouble()
            val alreadyOffscreen =
              !prevPx.isNaN() && prevSize > 0.0 && (prevPx + prevSize <= scrollPx || prevPx >= scrollPx + vpPx)
            if (!alreadyOffscreen && binding.appliedVisible != View.INVISIBLE) {
              if (view.visibility != View.INVISIBLE) view.visibility = View.INVISIBLE
              binding.appliedVisible = View.INVISIBLE
            }
            awaitingCount++
            continue
          }
          // Subtract mvcpMomentumShiftPx so content growth (+delta) offsets the +delta shift in offsetsBuf,
          // keeping the anchor stationary on screen without interrupting OverScroller!
          val targetPx = offsetsBuf[s] * density - mvcpMomentumShiftPx
          if (binding.appliedTargetPx != targetPx || binding.appliedGen != expectedGen) {
            if (horizontal) {
              if (abs(targetPx - view.left) > MAX_DIRECT_TRANSLATION_PX) {
                val desiredBase = (Math.floor(targetPx / SEGMENT_SHIFT_PX) * SEGMENT_SHIFT_PX).toInt()
                view.offsetLeftAndRight(desiredBase - view.left)
              }
              val relPx = (targetPx - view.left).toFloat()
              if (view.translationX != relPx) view.translationX = relPx
            } else {
              if (abs(targetPx - view.top) > MAX_DIRECT_TRANSLATION_PX) {
                val desiredBase = (Math.floor(targetPx / SEGMENT_SHIFT_PX) * SEGMENT_SHIFT_PX).toInt()
                view.offsetTopAndBottom(desiredBase - view.top)
              }
              val relPx = (targetPx - view.top).toFloat()
              if (view.translationY != relPx) view.translationY = relPx
            }
            binding.appliedTargetPx = targetPx
            binding.appliedGen = expectedGen
          }
          if (binding.appliedVisible != View.VISIBLE) {
            if (view.visibility != View.VISIBLE) view.visibility = View.VISIBLE
            binding.appliedVisible = View.VISIBLE
          }
        }

        pendingAwaitingGenCount = awaitingCount
        preDrawDirty = false
        if (jsWakeSentMs > 0L && awaitingCount == 0) {
          val rtt = (SystemClock.uptimeMillis() - jsWakeSentMs).coerceAtLeast(1L).toDouble()
          jsLatencyMs = jsLatencyMs * 0.5 + rtt * 0.5
          jsWakeSentMs = 0L
        }

        // Step 4: Keep sticky overlay pinned accurately on PreDraw too
        if (fullPass || layoutChanged) {
          applyStickyTransform(transHeader[1].toInt(), transHeader[2], density)
        }
      } finally {
        inPreDraw = false
      }
    }
  }

  fun attach(
    engineId: Long,
    scrollViewTag: Int,
    stickyViewTag: Int,
    horizontal: Boolean,
    userHasOnScroll: Boolean,
    onSlotRebinds: (Double, Double, Double, Double, Double, Double, Double, ArrayBuffer) -> Unit,
    onContentSize: (Double, Double) -> Unit,
  ): Int {
    val id = nextHostId.getAndIncrement()
    val session = HostSession(
      id, engineId, scrollViewTag, stickyViewTag, horizontal, userHasOnScroll, onSlotRebinds, onContentSize,
    )
    hosts[id] = session
    UiThreadUtil.runOnUiThread {
      session.attachUiListeners()
    }
    return id
  }

  fun detach(hostId: Int) {
    val session = hosts.remove(hostId) ?: return
    session.detached = true
    UiThreadUtil.runOnUiThread {
      session.detachUiListeners()
    }
  }

  fun registerSlotView(hostId: Int, slotId: Int, viewTag: Int, measures: Boolean) {
    val session = hosts[hostId] ?: return
    NativeHostBridge.nativeSetSlotViewTag(session.engineId, slotId, viewTag, measures)
    session.enqueueRegistration(slotId, viewTag)
  }

  fun unregisterSlotView(hostId: Int, slotId: Int) {
    val session = hosts[hostId] ?: return
    NativeHostBridge.nativeUnregisterSlotView(session.engineId, slotId)
    UiThreadUtil.runOnUiThread {
      session.removeSlotBinding(slotId)
    }
  }

  fun setSlotMeasures(hostId: Int, slotId: Int, measures: Boolean) {
    val session = hosts[hostId] ?: return
    NativeHostBridge.nativeSetSlotMeasures(session.engineId, slotId, measures)
  }

  fun setStickyViewTag(hostId: Int, stickyViewTag: Int) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.stickyViewTag = stickyViewTag
      session.stickyView = null
      session.preDrawDirty = true
      session.transformsDirty = true
    }
  }

  fun setUserHasOnScroll(hostId: Int, hasOnScroll: Boolean) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.userHasOnScroll = hasOnScroll
      session.resolveScrollView()?.let { session.applyThrottlePolicy(it) }
    }
  }

  fun setMvcpEnabled(hostId: Int, enabled: Boolean) {
    val session = hosts[hostId] ?: return
    session.mvcpEnabled = enabled
    NativeHostBridge.nativeSetMvcpEnabled(session.engineId, enabled)
  }

  fun applyMvcpShift(hostId: Int, deltaDp: Double) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.applyExternalMvcpShift(deltaDp)
    }
  }

  fun notifyDataCommit(hostId: Int, paddingStartDp: Double, mainAxisGapDp: Double) {
    val session = hosts[hostId] ?: return
    NativeHostBridge.nativeUpdateHostGeometry(session.engineId, paddingStartDp, mainAxisGapDp)
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      // Reset cached pixel heights on data commit so rebound cells report fresh sizes.
      for (i in 0..session.maxSlotIndex) {
        val b = session.slotArray[i] ?: continue
        b.lastMeasuredGen = -1
        b.lastMeasuredPx = -1
        b.appliedGen = -1
      }
      session.preDrawDirty = true
      session.transformsDirty = true
      val sv = session.resolveScrollView() ?: return@runOnUiThread
      session.handleScrollChange(sv, sv.scrollX, sv.scrollY)
      session.runPreDraw()
    }
  }

  fun syncNow(hostId: Int) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.preDrawDirty = true
      session.transformsDirty = true
      val sv = session.resolveScrollView() ?: return@runOnUiThread
      if (!NativeHostBridge.nativeIsPrewarmActive(session.engineId)) {
        session.handleScrollChange(sv, sv.scrollX, sv.scrollY)
      }
      session.runPreDraw()
    }
  }

  fun attachNativeSlotContainer(hostId: Int, containerViewTag: Int, numColumns: Int, crossAxisGapDp: Double) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      val resolved = session.resolveViewByTag(containerViewTag) as? ViewGroup
      session.templateEngine.setContainer(containerViewTag, numColumns, crossAxisGapDp, resolved)
      session.preDrawDirty = true
      session.transformsDirty = true
      val sv = session.resolveScrollView()
      if (sv != null) {
        if (!NativeHostBridge.nativeIsPrewarmActive(session.engineId)) {
          session.handleScrollChange(sv, sv.scrollX, sv.scrollY)
        }
        session.runPreDraw()
      }
    }
  }

  fun setNativeTemplateSchema(hostId: Int, schemaJson: String) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.setSchema(schemaJson)
      session.templateLoadNotified = false
      session.templateReportedContainerDp = 0.0
      session.preDrawDirty = true
      session.transformsDirty = true
      val sv = session.resolveScrollView()
      if (sv != null) {
        if (!NativeHostBridge.nativeIsPrewarmActive(session.engineId)) {
          session.handleScrollChange(sv, sv.scrollX, sv.scrollY)
        }
        session.runPreDraw()
      }
    }
  }

  fun setNativeTemplateData(
    hostId: Int,
    startIndex: Int,
    count: Int,
    totalCount: Int,
    reset: Boolean,
    packedData: ArrayBuffer,
  ) {
    val session = hosts[hostId] ?: return
    // Copy ArrayBuffer bytes synchronously on JSI thread before posting to UI thread so JS can
    // never race with UI-thread unpacking!
    val src = packedData.getBuffer(false)
    val len = src.remaining()
    if (len < 16) return
    val copy = ArrayBuffer.allocate(len)
    val dst = copy.getBuffer(false)
    dst.put(src.duplicate())
    dst.rewind()
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.setDataChunk(startIndex, count, totalCount, reset, copy)
      session.preDrawDirty = true
      session.transformsDirty = true
      val sv = session.resolveScrollView()
      if (sv != null) {
        if (!NativeHostBridge.nativeIsPrewarmActive(session.engineId)) {
          session.handleScrollChange(sv, sv.scrollX, sv.scrollY)
        }
        session.runPreDraw()
      }
    }
  }

  fun setNativePressHandler(hostId: Int, onPress: (Double, String) -> Unit) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.setPressHandler(onPress)
    }
  }

  fun setNativeDataRequestHandler(hostId: Int, onRequestData: (Double, Double) -> Unit) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.setDataRequestHandler(onRequestData)
    }
  }

  fun shiftNativeTemplateData(hostId: Int, delta: Int, totalCount: Int) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.shiftDataIndices(delta, totalCount)
      session.preDrawDirty = true
      session.transformsDirty = true
    }
  }

  fun clearNativeTemplate(hostId: Int) {
    val session = hosts[hostId] ?: return
    UiThreadUtil.runOnUiThread {
      if (session.detached) return@runOnUiThread
      session.templateEngine.clear()
      session.templateLoadNotified = false
      session.templateReportedContainerDp = 0.0
      session.preDrawDirty = true
      session.transformsDirty = true
    }
  }
}

/**
 * Level 2: Native Fresco bitmap-cache prefetcher with automatic ResizeOptions & cancellation.
 * Resolved lazily via reflection so it works seamlessly with React Native's bundled Fresco
 * without adding extra Gradle compile dependencies.
 */
private object NitroImagePrefetch {
  private const val MAX_IN_FLIGHT = 24

  private val lock = Any()
  private val inFlight = ArrayList<Any>(MAX_IN_FLIGHT)
  private var initialized = false
  private var available = false

  private var getImagePipelineMethod: Method? = null
  private var newBuilderWithSourceMethod: Method? = null
  private var setResizeOptionsMethod: Method? = null
  private var buildRequestMethod: Method? = null
  private var resizeOptionsCtor: java.lang.reflect.Constructor<*>? = null
  private var prefetchToBitmapCacheMethod: Method? = null
  private var dataSourceCloseMethod: Method? = null

  private fun ensureInitialized(): Boolean {
    if (initialized) return available
    synchronized(lock) {
      if (initialized) return available
      initialized = true
      try {
        val frescoClass = Class.forName("com.facebook.drawee.backends.pipeline.Fresco")
        val pipelineClass = Class.forName("com.facebook.imagepipeline.core.ImagePipeline")
        val builderClass = Class.forName("com.facebook.imagepipeline.request.ImageRequestBuilder")
        val requestClass = Class.forName("com.facebook.imagepipeline.request.ImageRequest")
        val resizeClass = Class.forName("com.facebook.imagepipeline.common.ResizeOptions")
        val dsClass = Class.forName("com.facebook.datasource.DataSource")

        getImagePipelineMethod = frescoClass.getMethod("getImagePipeline")
        newBuilderWithSourceMethod = builderClass.getMethod("newBuilderWithSource", Uri::class.java)
        setResizeOptionsMethod = builderClass.getMethod("setResizeOptions", resizeClass)
        buildRequestMethod = builderClass.getMethod("build")
        resizeOptionsCtor = resizeClass.getConstructor(Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
        prefetchToBitmapCacheMethod = pipelineClass.getMethod(
          "prefetchToBitmapCache", requestClass, Any::class.java,
        )
        dataSourceCloseMethod = dsClass.getMethod("close")
        available = true
      } catch (_: Throwable) {
        available = false
      }
    }
    return available
  }

  fun prefetch(uris: Array<String>, widthPx: Int, heightPx: Int) {
    if (uris.isEmpty() || !ensureInitialized()) return
    try {
      val pipeline = getImagePipelineMethod?.invoke(null) ?: return
      val resize = if (widthPx > 0 && heightPx > 0) {
        resizeOptionsCtor?.newInstance(widthPx, heightPx)
      } else {
        null
      }
      synchronized(lock) {
        for (raw in uris) {
          if (raw.isEmpty()) continue
          val parsed = Uri.parse(raw) ?: continue
          val builder = newBuilderWithSourceMethod?.invoke(null, parsed) ?: continue
          if (resize != null) {
            setResizeOptionsMethod?.invoke(builder, resize)
          }
          val request = buildRequestMethod?.invoke(builder) ?: continue
          val ds = prefetchToBitmapCacheMethod?.invoke(pipeline, request, null) ?: continue
          if (inFlight.size >= MAX_IN_FLIGHT) {
            val oldest = inFlight.removeAt(0)
            try { dataSourceCloseMethod?.invoke(oldest) } catch (_: Throwable) {}
          }
          inFlight.add(ds)
        }
      }
    } catch (_: Throwable) {
      // Never crash scroll if Fresco rejects a malformed URI.
    }
  }

  fun cancelAll() {
    if (!available) return
    synchronized(lock) {
      for (ds in inFlight) {
        try { dataSourceCloseMethod?.invoke(ds) } catch (_: Throwable) {}
      }
      inFlight.clear()
    }
  }
}
