import UIKit

/// Host UIView returned by `HybridNitroListView.view`. On iOS, Fabric does
/// **not** mount children inside this view — it mounts them as direct
/// subviews of the surrounding `RCTViewComponentView`, with this view as a
/// sibling (see `setContentView:` and `mountChildComponentView:` in
/// `RCTViewComponentView.mm`). Because `setContentView` runs first (during
/// `init`) and children are inserted at increasing indices afterward, this
/// view ends up as the last subview — i.e. the top of the z-order.
///
/// `RCTViewComponentView.betterHitTest:` iterates subviews in reverse, so it
/// reaches us first. A plain interactive `UIView` would return itself for
/// every touch inside its bounds and **swallow all taps before they reach
/// the cells**. We disable user interaction so `hitTest` returns `nil`
/// immediately and the hit-test loop falls through to the actual cells.
///
/// Safe to disable interaction here: this view never has React children of
/// its own (cells are siblings, not subviews).
///
/// Other intentional non-overrides:
/// - No `layoutSubviews` override — Fabric/Yoga sets each child's `.frame`
///   directly. UIKit's default `layoutSubviews` leaves child frames alone.
/// - No `intrinsicContentSize` override — JS sets
///   `style={{ height: hybrid.getTotalSize() }}` on the host component.
final class NitroListContentView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }
}
