package com.margelo.nitro.nitrolist.views

import android.view.ViewGroup
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.margelo.nitro.R.id.associated_hybrid_view_tag
import com.margelo.nitro.nitrolist.HybridNitroListView

// We replace nitrogen's generated HybridNitroListViewManager (which extends
// SimpleViewManager) with a ViewGroupManager so Fabric's mounting layer can
// cast to IViewGroupManager and add children to our HybridView. The body
// mirrors the generated manager's behavior; only the base class differs.
class NitroListViewGroupManager : ViewGroupManager<ViewGroup>() {
  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): ViewGroup {
    val hybridView = HybridNitroListView(reactContext)
    val view = hybridView.view as ViewGroup
    view.setTag(associated_hybrid_view_tag, hybridView)
    return view
  }

  override fun updateState(view: ViewGroup, props: ReactStylesDiffMap, stateWrapper: StateWrapper): Any? {
    val hybridView = getHybridView(view)
      ?: throw IllegalStateException("Couldn't find HybridNitroListView for $view in local views table!")
    hybridView.beforeUpdate()
    HybridNitroListViewStateUpdater.updateViewProps(hybridView, stateWrapper)
    hybridView.afterUpdate()
    return super.updateState(view, props, stateWrapper)
  }

  override fun onDropViewInstance(view: ViewGroup) {
    getHybridView(view)?.onDropView()
    super.onDropViewInstance(view)
  }

  private fun getHybridView(view: ViewGroup): HybridNitroListView? =
    view.getTag(associated_hybrid_view_tag) as? HybridNitroListView

  companion object {
    const val NAME = "NitroListView"
  }
}
