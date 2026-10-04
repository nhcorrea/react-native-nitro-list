package com.margelo.nitro.nitrolist

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.IllegalViewOperationException
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import com.margelo.nitro.NitroModules
import java.util.WeakHashMap

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
