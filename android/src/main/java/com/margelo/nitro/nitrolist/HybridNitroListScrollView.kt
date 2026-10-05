package com.margelo.nitro.nitrolist

import android.os.SystemClock
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
    // All programmatic commands use this queue, including animations. Splitting
    // cancellation and the next scroll between Nitro and Fabric would race.
    UiThreadUtil.runOnUiThread {
      val manager = UIManagerHelper.getUIManagerForReactTag(context, tag) ?: return@runOnUiThread
      val view = try {
        manager.resolveView(tag)
      } catch (_: IllegalViewOperationException) {
        // The list can unmount between the JS call and execution on the UI thread.
        return@runOnUiThread
      }
      val destX = Math.round(PixelUtil.toPixelFromDIP(x))
      val destY = Math.round(PixelUtil.toPixelFromDIP(y))
      if (view is ViewGroup) PendingDestinations.clear(view)
      when (view) {
        is ReactScrollView -> {
          // RN's abortAnimation stops OverScroller, but a programmatic smooth
          // scroll uses a separate ValueAnimator that otherwise keeps writing.
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

  override fun observeMounts(markerTag: Double, onMounted: (sequence: Double, mountMs: Double) -> Unit): Double {
    if (!markerTag.isFinite() || markerTag <= 0 || markerTag > Int.MAX_VALUE) return -1.0
    return MountObserver.observe(markerTag.toInt(), onMounted).toDouble()
  }

  override fun unobserveMounts(id: Double) {
    if (id.isFinite() && id > 0) MountObserver.unobserve(id.toInt())
  }
}

@OptIn(UnstableReactNativeAPI::class)
private object MountObserver {
  private class Watch(val tag: Int, val callback: (Double, Double) -> Unit) {
    var view: WeakReference<View>? = null
    var last = Double.NaN
  }

  private val watches = ConcurrentHashMap<Int, Watch>()
  private var nextId = 1
  private var manager: UIManager? = null
  private var mountStartNs = 0L

  private val listener = object : UIManagerListener {
    override fun willDispatchViewUpdates(uiManager: UIManager) {}

    override fun willMountItems(uiManager: UIManager) {
      mountStartNs = System.nanoTime()
    }

    override fun didMountItems(uiManager: UIManager) {
      if (watches.isEmpty()) return
      val mountMs = if (mountStartNs > 0L) (System.nanoTime() - mountStartNs) / 1e6 else 0.0
      for (watch in watches.values) {
        val view = watch.view?.get() ?: resolve(uiManager, watch.tag)?.also { watch.view = WeakReference(it) } ?: continue
        val sequence = (view.getTag(R.id.react_test_id) as? String)?.toDoubleOrNull() ?: continue
        if (sequence == watch.last) continue
        watch.last = sequence
        watch.callback(sequence, mountMs)
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

  @Synchronized
  fun unobserve(id: Int) {
    watches.remove(id)
    if (watches.isEmpty()) {
      manager?.removeUIManagerEventListener(listener)
      manager = null
    }
  }
}

@OptIn(UnstableReactNativeAPI::class)
private object EagerMount {
  private var holders = 0
  private var manager: UIManager? = null
  private var unavailable = false
  private val scheduled = AtomicBoolean(false)

  @Volatile private var dispatch: Runnable? = null

  private val listener = object : UIManagerListener {
    override fun willDispatchViewUpdates(uiManager: UIManager) {}

    override fun willMountItems(uiManager: UIManager) {}

    override fun didMountItems(uiManager: UIManager) {}

    override fun didDispatchMountItems(uiManager: UIManager) {}

    override fun didScheduleMountItems(uiManager: UIManager) {
      val run = dispatch ?: return
      if (scheduled.compareAndSet(false, true)) UiThreadUtil.runOnUiThread(run)
    }
  }

  @Synchronized
  fun set(enabled: Boolean) {
    if (unavailable) return
    val context = NitroModules.applicationContext ?: return
    val current = UIManagerHelper.getUIManager(context, UIManagerType.FABRIC) ?: return
    if (current !== manager) {
      detach()
      holders = 0
    }
    if (enabled) {
      holders++
      if (holders == 1) attach(current)
    } else if (holders > 0) {
      holders--
      if (holders == 0) detach()
    }
  }

  private fun attach(uiManager: UIManager) {
    try {
      val field = uiManager.javaClass.getDeclaredField("mMountItemDispatcher")
      field.isAccessible = true
      val dispatcher = field.get(uiManager) ?: return
      val method = dispatcher.javaClass.getMethod("tryDispatchMountItems")
      dispatch = Runnable {
        scheduled.set(false)
        try {
          method.invoke(dispatcher)
        } catch (error: InvocationTargetException) {
          throw error.cause ?: error
        } catch (_: IllegalAccessException) {
          unavailable = true
          dispatch = null
        }
      }
      uiManager.addUIManagerEventListener(listener)
      manager = uiManager
    } catch (_: ReflectiveOperationException) {
      unavailable = true
    } catch (_: SecurityException) {
      unavailable = true
    }
  }

  private fun detach() {
    manager?.removeUIManagerEventListener(listener)
    manager = null
    dispatch = null
  }
}

private object PendingDestinations {
  private const val WINDOW_MS = 500L

  private class Pending(val content: View, val listener: View.OnLayoutChangeListener)

  private val pending = WeakHashMap<ViewGroup, Pending>()

  fun clear(view: ViewGroup) {
    val current = pending.remove(view) ?: return
    current.content.removeOnLayoutChangeListener(current.listener)
  }

  fun hold(view: ViewGroup, x: Int, y: Int) {
    val content = view.getChildAt(0) ?: return
    val horizontal = view is ReactHorizontalScrollView
    val deadline = SystemClock.uptimeMillis() + WINDOW_MS
    val listener = View.OnLayoutChangeListener { _, _, _, _, _, oldLeft, oldTop, oldRight, oldBottom ->
      if (SystemClock.uptimeMillis() > deadline) {
        clear(view)
        return@OnLayoutChangeListener
      }
      val previousMax = if (horizontal) oldRight - oldLeft - view.width else oldBottom - oldTop - view.height
      val current = if (horizontal) view.scrollX else view.scrollY
      if (current != (if (horizontal) x else y) && current == maxOf(0, previousMax)) view.scrollTo(x, y)
    }
    pending[view] = Pending(content, listener)
    content.addOnLayoutChangeListener(listener)
  }
}
