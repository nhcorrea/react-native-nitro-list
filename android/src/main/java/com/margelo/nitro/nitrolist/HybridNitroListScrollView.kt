package com.margelo.nitro.nitrolist

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.UIManagerListener
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.uimanager.IllegalViewOperationException
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import com.margelo.nitro.NitroModules
import java.lang.reflect.InvocationTargetException
import java.util.WeakHashMap
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
