package com.margelo.nitro.nitrolist.views

import android.view.ViewGroup
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.margelo.nitro.R.id.associated_hybrid_view_tag
import com.margelo.nitro.nitrolist.HybridNitroListView
import com.margelo.nitro.views.RecyclableView

class NitroListViewGroupManager : ViewGroupManager<ViewGroup>() {
  /**
   * Holds the view and its last state snapshot. The updater diffs [lastState]
   * against the incoming state to decide which props actually changed.
   */
  private class HybridViewHolder(
    val hybridView: HybridNitroListView,
    var lastState: StateWrapper? = null,
  )

  init {
    if (RecyclableView::class.java.isAssignableFrom(HybridNitroListView::class.java)) {
      setupViewRecycling()
    }
  }

  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): ViewGroup {
    val hybridView = HybridNitroListView(reactContext)
    val view = hybridView.view as ViewGroup
    view.setTag(associated_hybrid_view_tag, HybridViewHolder(hybridView))
    return view
  }

  override fun updateState(view: ViewGroup, props: ReactStylesDiffMap, stateWrapper: StateWrapper): Any? {
    val holder = getHolder(view)
      ?: throw IllegalStateException("Couldn't find HybridNitroListView for $view in local views table!")
    val hybridView = holder.hybridView
    hybridView.beforeUpdate()
    HybridNitroListViewStateUpdater.updateViewProps(hybridView, stateWrapper, holder.lastState)
    hybridView.afterUpdate()
    holder.lastState = stateWrapper
    return super.updateState(view, props, stateWrapper)
  }

  override fun onDropViewInstance(view: ViewGroup) {
    val holder = getHolder(view)
    holder?.lastState = null
    holder?.hybridView?.onDropView()
    super.onDropViewInstance(view)
  }

  protected override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ViewGroup): ViewGroup? {
    val preparedView = super.prepareToRecycleView(reactContext, view) ?: return null
    val holder = getHolder(preparedView) ?: return null
    holder.lastState = null
    val hybridView = holder.hybridView

    @Suppress("USELESS_IS_CHECK")
    if (hybridView !is RecyclableView) return null
    hybridView.prepareForRecycle()
    return hybridView.view as ViewGroup
  }

  private fun getHolder(view: ViewGroup): HybridViewHolder? =
    view.getTag(associated_hybrid_view_tag) as? HybridViewHolder

  companion object {
    const val NAME = "NitroListView"
  }
}
