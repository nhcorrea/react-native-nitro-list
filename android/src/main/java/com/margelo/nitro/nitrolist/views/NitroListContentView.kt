package com.margelo.nitro.nitrolist.views

import android.content.Context
import android.widget.FrameLayout

class NitroListContentView(context: Context) : FrameLayout(context) {
  private var layoutManager: LayoutManager? = null
  private var horizontal: Boolean = false

  fun bindLayoutManager(manager: LayoutManager) {
    layoutManager = manager
    requestLayout()
  }

  fun setHorizontal(value: Boolean) {
    if (horizontal == value) return
    horizontal = value
    requestLayout()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val totalPx = layoutManager?.getTotalSizePx()?.toInt() ?: 0
    if (horizontal) {
      val width = if (totalPx > 0) totalPx else MeasureSpec.getSize(widthMeasureSpec)
      setMeasuredDimension(width, MeasureSpec.getSize(heightMeasureSpec))
    } else {
      val width = MeasureSpec.getSize(widthMeasureSpec)
      val height = if (totalPx > 0) totalPx else MeasureSpec.getSize(heightMeasureSpec)
      setMeasuredDimension(width, height)
    }
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { }
}
