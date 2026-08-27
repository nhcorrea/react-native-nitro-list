import os

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
