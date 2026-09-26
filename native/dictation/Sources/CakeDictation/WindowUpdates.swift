/// One sequential protocol request waits for a known number of model windows. The stream
/// consumer runs off the main actor so AsyncStream's macOS 14 iterator never crosses isolation.
actor WindowUpdates {
  private var completed = 0
  private var waiter: (target: Int, continuation: CheckedContinuation<Void, Never>)?

  func advance() {
    completed += 1
    if let waiter, completed >= waiter.target {
      self.waiter = nil
      waiter.continuation.resume()
    }
  }

  func wait(until target: Int) async {
    if completed >= target { return }
    await withCheckedContinuation { continuation in
      waiter = (target, continuation)
    }
  }
}
