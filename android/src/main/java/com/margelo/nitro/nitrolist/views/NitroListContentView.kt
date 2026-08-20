package com.margelo.nitro.nitrolist.views

import android.content.Context
import android.widget.FrameLayout

class NitroListContentView(context: Context) : FrameLayout(context) {
  private var layoutManager: LayoutManager? = null

  fun bindLayoutManager(manager: LayoutManager) {
    layoutManager = manager
    requestLayout()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val totalPx = layoutManager?.getTotalSizePx()?.toInt() ?: 0
    val height = if (totalPx > 0) totalPx else MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(width, height)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { }
}
