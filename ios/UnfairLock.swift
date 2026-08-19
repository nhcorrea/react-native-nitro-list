import os

/// Heap-allocated `os_unfair_lock` wrapper. We can't store `os_unfair_lock` as
/// a Swift property and pass `&self.lock` to `os_unfair_lock_lock` — Swift may
/// pass a temporary copy, and copies of unfair locks are undefined behavior.
/// `OSAllocatedUnfairLock` would solve this, but it's iOS 16+ and our target
/// is lower. NOT reentrant — never nest `withLock` on the same instance.
final class UnfairLock {
  private let ptr: UnsafeMutablePointer<os_unfair_lock>

  init() {
    ptr = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    ptr.initialize(to: os_unfair_lock())
  }

  deinit {
    ptr.deinitialize(count: 1)
    ptr.deallocate()
  }

  @inline(__always)
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    os_unfair_lock_lock(ptr)
    defer { os_unfair_lock_unlock(ptr) }
    return try body()
  }
}
