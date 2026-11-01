package com.margelo.nitro.nitrolist

import android.os.SystemClock
import android.os.Trace
import android.view.View
import android.view.ViewGroup
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.UIManagerListener
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.R
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.uimanager.IllegalViewOperationException
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import com.margelo.nitro.NitroModules
import java.lang.reflect.InvocationTargetException
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

@Keep
@DoNotStrip
class HybridNitroListScrollView : HybridNitroListScrollViewSpec() {
  override fun scrollTo(viewTag: Double, x: Double, y: Double, animated: Boolean) {
    if (!viewTag.isFinite() || viewTag <= 0 || viewTag > Int.MAX_VALUE ||
        viewTag != viewTag.toInt().toDouble() || !x.isFinite() || !y.isFinite()) return
    val context = NitroModules.applicationContext ?: return
    val tag = viewTag.toInt()
    UiThreadUtil.runOnUiThread {
      val manager = UIManagerHelper.getUIManagerForReactTag(context, tag) ?: return@runOnUiThread
      val view = try {
        manager.resolveView(tag)
      } catch (_: IllegalViewOperationException) {
        return@runOnUiThread
      }
      val density = PixelUtil.getDisplayMetricDensity().toDouble()
      val destX = Math.round(x * density).toInt()
      val destY = Math.round(y * density).toInt()
      if (view is ViewGroup) PendingDestinations.clear(view)
      when (view) {
        is ReactScrollView -> {
          view.flingAnimator.cancel()
          view.abortAnimation()
          if (animated) view.reactSmoothScrollTo(destX, destY)
          else {
            view.scrollTo(destX, destY)
            PendingDestinations.hold(view, destX, destY)
          }
        }
        is ReactHorizontalScrollView -> {
          view.flingAnimator.cancel()
          view.abortAnimation()
          if (animated) view.reactSmoothScrollTo(destX, destY)
          else {
            view.scrollTo(destX, destY)
            PendingDestinations.hold(view, destX, destY)
          }
        }
      }
    }
  }

  override fun setEagerMount(enabled: Boolean) {
    EagerMount.set(enabled)
  }

  override fun setClipChildren(viewTag: Double, enabled: Boolean) {
    if (!viewTag.isFinite() || viewTag <= 0 || viewTag > Int.MAX_VALUE ||
        viewTag != viewTag.toInt().toDouble()) return
    ChildClipping.request(viewTag.toInt(), enabled)
  }

  override fun observeMounts(markerTag: Double, onMounted: (sequence: Double, mountMs: Double) -> Unit): Double {
    if (!markerTag.isFinite() || markerTag <= 0 || markerTag > Int.MAX_VALUE) return -1.0
    return MountObserver.observe(markerTag.toInt(), onMounted).toDouble()
  }

  override fun unobserveMounts(id: Double) {
    if (id.isFinite() && id > 0) MountObserver.unobserve(id.toInt())
  }

  override fun mountedAtMs(id: Double, sequence: Double): Double {
    if (!id.isFinite() || id <= 0 || id > Int.MAX_VALUE || !sequence.isFinite()) return -1.0
    return MountObserver.mountedAt(id.toInt(), sequence)
  }

  override fun setTransitionDiagnostics(enabled: Boolean) {
    TransitionDiagnostics.enabled.set(enabled)
  }

  override fun markTransition(origin: Double, sequence: Double, revision: Double, count: Double, flags: Double) {
    TransitionDiagnostics.mark(origin.toInt(), sequence.toLong(), revision.toLong(), count.toInt(), flags.toInt())
  }
}

private object TransitionDiagnostics {
  val enabled = AtomicBoolean(false)
  private val origins = arrayOf("unknown", "range", "prewarm", "reserve", "measure", "data", "correction", "driver", "mount", "other")

  fun mark(origin: Int, sequence: Long, revision: Long, count: Int, flags: Int) {
    if (!enabled.get()) return
    val name = origins.getOrElse(origin) { "unknown" }
    Trace.beginSection("NL:$name#$sequence r$revision n$count f$flags")
    Trace.endSection()
  }

  fun ack(sequence: Long) {
    if (!enabled.get()) return
    Trace.beginSection("NL:mount_ack#$sequence")
    Trace.endSection()
  }
}

@OptIn(UnstableReactNativeAPI::class)
private object MountObserver {
  private const val STAMPS_KEPT = 8

  private class Watch(val tag: Int, val callback: (Double, Double) -> Unit) {
    var view: WeakReference<View>? = null
    var last = Double.NaN
    @Volatile var stamps = DoubleArray(0)

    fun stamp(sequence: Double, uptimeMs: Double) {
      val previous = stamps
      val kept = minOf(previous.size, (STAMPS_KEPT - 1) * 2)
      val next = DoubleArray(kept + 2)
      System.arraycopy(previous, previous.size - kept, next, 0, kept)
      next[kept] = sequence
      next[kept + 1] = uptimeMs
      stamps = next
    }
  }

  private val watches = ConcurrentHashMap<Int, Watch>()
  private var nextId = 1
  private var manager: UIManager? = null
  private var mountStartNs = 0L
  private var mountStartUptimeMs = 0L

  private val listener = object : UIManagerListener {
    override fun willDispatchViewUpdates(uiManager: UIManager) {}

    override fun willMountItems(uiManager: UIManager) {
      mountStartNs = System.nanoTime()
      mountStartUptimeMs = SystemClock.uptimeMillis()
    }

    override fun didMountItems(uiManager: UIManager) {
      if (watches.isEmpty()) return
      val mountMs = if (mountStartNs > 0L) (System.nanoTime() - mountStartNs) / 1e6 else 0.0
      for (watch in watches.values) {
        val view = watch.view?.get() ?: resolve(uiManager, watch.tag)?.also { watch.view = WeakReference(it) } ?: continue
        val sequence = (view.getTag(R.id.react_test_id) as? String)?.toDoubleOrNull() ?: continue
        if (sequence == watch.last) continue
        watch.last = sequence
        watch.stamp(sequence, mountStartUptimeMs.toDouble())
        watch.callback(sequence, mountMs)
        TransitionDiagnostics.ack(sequence.toLong())
      }
    }

    override fun didDispatchMountItems(uiManager: UIManager) {}

    override fun didScheduleMountItems(uiManager: UIManager) {}
  }

  private fun resolve(uiManager: UIManager, tag: Int): View? = try {
    uiManager.resolveView(tag)
  } catch (_: IllegalViewOperationException) {
    null
  }

  @Synchronized
  fun observe(tag: Int, callback: (Double, Double) -> Unit): Int {
    val context = NitroModules.applicationContext ?: return -1
    val current = UIManagerHelper.getUIManager(context, UIManagerType.FABRIC) ?: return -1
    if (current !== manager) {
      manager?.removeUIManagerEventListener(listener)
      watches.clear()
      current.addUIManagerEventListener(listener)
      manager = current
    }
    val id = nextId++
    watches[id] = Watch(tag, callback)
    return id
  }

  fun mountedAt(id: Int, sequence: Double): Double {
    val stamps = watches[id]?.stamps ?: return -1.0
    var at = 0
    while (at < stamps.size) {
      if (stamps[at] >= sequence) return stamps[at + 1]
      at += 2
    }
    return -1.0
  }

  @Synchronized
  fun unobserve(id: Int) {
    watches.remove(id)
    if (watches.isEmpty()) {
      manager?.removeUIManagerEventListener(listener)
      manager = null
    }
  }
}

@Keep
@DoNotStrip
@OptIn(UnstableReactNativeAPI::class)
private object EagerMount {
  private class Generation(val id: Long, val manager: UIManager) {
    val scheduled = AtomicBoolean(false)
    @Volatile var active = true
    lateinit var run: Runnable
  }
  private var holders = 0
  private var nextGeneration = 0L
  private var unavailable = false
  private val dispatches = java.util.concurrent.atomic.AtomicLong(0)
  private val staleDrops = java.util.concurrent.atomic.AtomicLong(0)
  @Volatile private var generation: Generation? = null

  private fun schedule(current: Generation) {
    if (current.active && current.scheduled.compareAndSet(false, true)) {
      UiThreadUtil.runOnUiThread(current.run)
    }
  }
  private val listener = object : UIManagerListener {
    override fun willDispatchViewUpdates(uiManager: UIManager) {}
    override fun willMountItems(uiManager: UIManager) {}
    override fun didMountItems(uiManager: UIManager) {}
    override fun didDispatchMountItems(uiManager: UIManager) {}
    override fun didScheduleMountItems(uiManager: UIManager) {
      val current = generation ?: return
      if (current.manager === uiManager) schedule(current)
    }
  }

  @Synchronized
  fun set(enabled: Boolean) {
    if (!enabled) {
      if (holders > 0 && --holders == 0) detach()
      return
    }
    if (unavailable) return
    val context = NitroModules.applicationContext ?: return
    val manager = UIManagerHelper.getUIManager(context, UIManagerType.FABRIC) ?: return
    if (generation?.manager !== manager) {
      detach()
      holders = 0
    }
    if (holders > 0) holders++ else if (attach(manager)) holders = 1
  }

  private fun attach(manager: UIManager): Boolean {
    try {
      val field = manager.javaClass.getDeclaredField("mMountItemDispatcher")
      field.isAccessible = true
      val dispatcher = field.get(manager) ?: return false
      val method = dispatcher.javaClass.getMethod("tryDispatchMountItems")
      val current = Generation(++nextGeneration, manager)
      current.run = Runnable {
        if (!current.active || generation !== current) {
          staleDrops.incrementAndGet()
          return@Runnable
        }
        current.scheduled.set(false)
        Trace.beginSection("NL:eager_dispatch")
        try {
          dispatches.incrementAndGet()
          method.invoke(dispatcher)
        } catch (error: InvocationTargetException) {
          throw error.cause ?: error
        } catch (_: IllegalAccessException) {
          synchronized(this) {
            unavailable = true
            if (generation === current) { detach(); holders = 0 }
          }
        } finally {
          Trace.endSection()
        }
      }
      generation = current
      manager.addUIManagerEventListener(listener)
      return true
    } catch (_: ReflectiveOperationException) {
      unavailable = true
    } catch (_: SecurityException) {
      unavailable = true
    }
    detach()
    return false
  }

  private fun detach() {
    val current = generation ?: return
    current.active = false
    generation = null
    current.manager.removeUIManagerEventListener(listener)
  }

  @Synchronized fun diagnosticSnapshot(): Map<String, Long> = mapOf(
    "holders" to holders.toLong(), "generation" to nextGeneration,
    "attached" to if (generation != null) 1L else 0L,
    "scheduled" to if (generation?.scheduled?.get() == true) 1L else 0L,
    "unavailable" to if (unavailable) 1L else 0L,
    "dispatches" to dispatches.get(), "staleDrops" to staleDrops.get())
  fun diagnosticSchedule() { generation?.let { schedule(it) } }
}

@OptIn(UnstableReactNativeAPI::class)
private object ChildClipping {
  private const val MOUNT_PASSES_KEPT = 120

  private class Request(var enabled: Boolean, var passesLeft: Int)

  private val pending = HashMap<Int, Request>()
  private var manager: UIManager? = null

  private val listener = object : UIManagerListener {
    override fun willDispatchViewUpdates(uiManager: UIManager) {}

    override fun willMountItems(uiManager: UIManager) {}

    override fun didMountItems(uiManager: UIManager) {
      apply(uiManager)
    }

    override fun didDispatchMountItems(uiManager: UIManager) {}

    override fun didScheduleMountItems(uiManager: UIManager) {}
  }

  fun request(tag: Int, enabled: Boolean) {
    val context = NitroModules.applicationContext ?: return
    UiThreadUtil.runOnUiThread {
      val uiManager = UIManagerHelper.getUIManager(context, UIManagerType.FABRIC) ?: return@runOnUiThread
      val request = pending[tag]
      if (request == null) pending[tag] = Request(enabled, MOUNT_PASSES_KEPT)
      else {
        request.enabled = enabled
        request.passesLeft = MOUNT_PASSES_KEPT
      }
      apply(uiManager)
      if (pending.isNotEmpty() && manager !== uiManager) {
        manager?.removeUIManagerEventListener(listener)
        uiManager.addUIManagerEventListener(listener)
        manager = uiManager
      }
    }
  }

  private fun apply(uiManager: UIManager) {
    val entries = pending.entries.iterator()
    while (entries.hasNext()) {
      val (tag, request) = entries.next()
      val view = try {
        uiManager.resolveView(tag)
      } catch (_: IllegalViewOperationException) {
        null
      }
      if (view is ViewGroup) {
        if (view.clipChildren != request.enabled) {
          view.clipChildren = request.enabled
          view.invalidate()
        }
        entries.remove()
      } else if (--request.passesLeft <= 0) {
        entries.remove()
      }
    }
    if (pending.isEmpty() && manager != null) {
      manager?.removeUIManagerEventListener(listener)
      manager = null
    }
  }
}

internal object PendingDestinations {
  private const val WINDOW_MS = 500L

  private class Pending(val content: WeakReference<View>, val listener: View.OnLayoutChangeListener)

  private val pending = WeakHashMap<ViewGroup, Pending>()

  fun clear(view: ViewGroup) {
    val current = pending.remove(view) ?: return
    current.content.get()?.removeOnLayoutChangeListener(current.listener)
  }

  fun hold(view: ViewGroup, x: Int, y: Int) {
    val content = view.getChildAt(0) ?: return
    val horizontal = view is ReactHorizontalScrollView
    val deadline = SystemClock.uptimeMillis() + WINDOW_MS
    val target = WeakReference(view)
    val listener = View.OnLayoutChangeListener { _, _, _, _, _, oldLeft, oldTop, oldRight, oldBottom ->
      val scroller = target.get() ?: return@OnLayoutChangeListener
      if (SystemClock.uptimeMillis() > deadline) {
        clear(scroller)
        return@OnLayoutChangeListener
      }
      val previousMax = if (horizontal) oldRight - oldLeft - scroller.width else oldBottom - oldTop - scroller.height
      val current = if (horizontal) scroller.scrollX else scroller.scrollY
      if (current != (if (horizontal) x else y) && current == maxOf(0, previousMax)) scroller.scrollTo(x, y)
    }
    pending[view] = Pending(WeakReference(content), listener)
    content.addOnLayoutChangeListener(listener)
  }
}
