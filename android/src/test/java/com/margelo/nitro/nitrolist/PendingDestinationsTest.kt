package com.margelo.nitro.nitrolist

import android.view.View
import android.view.ViewGroup
import java.lang.ref.WeakReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingDestinationsTest {
  private class Content(val parent: ViewGroup) : View(null) {
    val listeners = ArrayList<View.OnLayoutChangeListener>()

    override fun addOnLayoutChangeListener(listener: View.OnLayoutChangeListener) {
      listeners.add(listener)
    }

    override fun removeOnLayoutChangeListener(listener: View.OnLayoutChangeListener) {
      listeners.remove(listener)
    }
  }

  private class Scroller : ViewGroup(null) {
    var content: Content? = null
    var scrolls = 0

    override fun getChildAt(index: Int): View? = if (index == 0) content else null

    override fun scrollTo(x: Int, y: Int) {
      scrolls++
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {}
  }

  private fun holdDetached(): WeakReference<ViewGroup> {
    val scroller = Scroller()
    scroller.content = Content(scroller)
    PendingDestinations.hold(scroller, 0, 1200)
    return WeakReference(scroller)
  }

  private fun collected(reference: WeakReference<*>): Boolean {
    repeat(50) {
      if (reference.get() == null) return true
      System.gc()
      Thread.sleep(10)
    }
    return reference.get() == null
  }

  @Test
  fun unmountedScrollViewIsCollectedWithoutAnotherLayout() {
    val reference = holdDetached()
    assertTrue("scroll view retained after unmount", collected(reference))
  }

  @Test
  fun clearRemovesTheLayoutListener() {
    val scroller = Scroller()
    val content = Content(scroller)
    scroller.content = content
    PendingDestinations.hold(scroller, 0, 1200)
    assertEquals(1, content.listeners.size)
    PendingDestinations.clear(scroller)
    assertEquals(0, content.listeners.size)
  }

  @Test
  fun layoutInsideTheWindowReappliesTheDestination() {
    val scroller = Scroller()
    val content = Content(scroller)
    scroller.content = content
    PendingDestinations.hold(scroller, 0, 1200)
    content.listeners.single().onLayoutChange(content, 0, 0, 0, 0, 0, 0, 0, 0)
    assertEquals(1, scroller.scrolls)
    PendingDestinations.clear(scroller)
  }
}
