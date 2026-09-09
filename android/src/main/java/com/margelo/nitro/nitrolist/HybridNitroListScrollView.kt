package com.margelo.nitro.nitrolist

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.IllegalViewOperationException
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import com.margelo.nitro.NitroModules

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
      when (view) {
        is ReactScrollView -> {
          // RN's abortAnimation stops OverScroller, but a programmatic smooth
          // scroll uses a separate ValueAnimator that otherwise keeps writing.
          view.flingAnimator.cancel()
          view.abortAnimation()
          if (animated) view.reactSmoothScrollTo(destX, destY)
          else view.scrollTo(destX, destY)
        }
        is ReactHorizontalScrollView -> {
          view.flingAnimator.cancel()
          view.abortAnimation()
          if (animated) view.reactSmoothScrollTo(destX, destY)
          else view.scrollTo(destX, destY)
        }
      }
    }
  }
}
