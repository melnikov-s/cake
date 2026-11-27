/// Bounded sliding context; lookahead is assessed but never emitted twice. A span flush
/// drains its remaining samples without retaining them into the next text insertion.
public struct SpeakerWindows: Sendable {
  public struct Window: Sendable {
    public let audio: [Float]
    public let output: Range<Int>
  }

  public static let stride = 16_384  // 1.024 s at 16 kHz
  public static let context = 8_192  // 512 ms of normal context on each side
  public static let recoveryHistory = 3 * stride  // 3.072 s of past audio, no added lookahead
  private var history: [Float] = []
  private var pending: [Float] = []

  public init() {}

  public mutating func append(_ samples: [Float]) throws {
    // One bounded wire batch (at most ten seconds), plus the partial window from last time.
    guard samples.count <= 160_000, pending.count < Self.stride + Self.context else {
      throw ProtocolError.invalidRequest
    }
    pending += samples
  }

  public mutating func next(final: Bool) -> Window? {
    guard !pending.isEmpty, final || pending.count >= Self.stride + Self.context else {
      return nil
    }
    let count = min(Self.stride, pending.count)
    let window = Window(
      audio: history + pending.prefix(count + Self.context),
      output: history.count..<(history.count + count))
    history = Array((history + pending.prefix(count)).suffix(Self.recoveryHistory))
    pending.removeFirst(count)
    if final && pending.isEmpty { history = [] }
    return window
  }
}
