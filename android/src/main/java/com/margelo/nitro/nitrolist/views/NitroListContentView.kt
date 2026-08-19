package com.margelo.nitro.nitrolist.views

import android.content.Context
import android.widget.FrameLayout

/**
 * The view that the consumer puts inside their own ScrollView. Children come
 * from React via the standard Fabric mount path; we just report our intrinsic
 * height (= LayoutManager total size) so the outer ScrollView gets the right
 * scrollable area.
 *
 * onLayout is intentionally left empty: Fabric directly invokes child.layout()
 * on every child with the position computed by Yoga (style.top/left). Letting
 * FrameLayout's default child positioning run would override those positions
 * with gravity-based layout.
 */
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
    // Children are NOT re-measured here. Fabric measures every child with
    // EXACTLY specs (Yoga-computed size) and calls child.layout() directly —
    // the same reason onLayout below is empty. Re-measuring them with AT_MOST
    // height both wasted a full child-measure pass per relayout and could
    // leave a child's measured state out of sync with the frame Fabric set.
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) { }
}
