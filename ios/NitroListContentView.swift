import UIKit

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
