import Foundation

/// Audio-clock segmentation, independent of Core ML so boundary policy is testable.
/// The detector supplies speech decisions; loudness is deliberately not a proxy for speech.
public struct SpeechGate: Sendable {
  public enum Event: Sendable {
    case audio([Float])
    case end
  }
  private var preroll: [Float] = []
  private var active = false
  private var quiet = 0
  private var duration = 0
  private var pendingSilence = 0
  public static let frameSamples = 4096
  private let paddingSamples = 4096
  private let endpointSamples = 24_000  // 1.5 seconds; ordinary thinking pauses stay within a phrase.
  private let maximumSamples = 480_000  // Bound a continuous phrase to 30 seconds.

  public init() {}

  public mutating func append(_ samples: [Float], speech: Bool) -> [Event] {
    guard !samples.isEmpty else { return [] }
    if !active {
      if !speech {
        preroll.append(contentsOf: samples)
        if preroll.count > paddingSamples { preroll.removeFirst(preroll.count - paddingSamples) }
        return []
      }
      active = true
      duration = 0
      quiet = 0
      let audio = preroll + samples
      preroll = []
      duration += audio.count
      return [.audio(audio)]
    }
    duration += samples.count
    quiet = speech ? 0 : quiet + samples.count
    // Retain short internal pauses only if speech resumes. Room noise never becomes a new window.
    let audio = speech ? [Float](repeating: 0, count: pendingSilence) + samples : samples
    if speech { pendingSilence = 0 }
    if quiet >= endpointSamples || duration >= maximumSamples {
      let retainTail = speech || quiet <= paddingSamples
      active = false
      quiet = 0
      duration = 0
      preroll = []
      pendingSilence = 0
      // A duration limit must not discard the speech frame that crosses it.
      // For a quiet endpoint, finish() supplies decoder lookahead without a long noise window.
      return retainTail ? [.audio(audio), .end] : [.end]
    }
    if quiet > paddingSamples {
      pendingSilence += samples.count
      return []
    }
    return [.audio(audio)]
  }

  public mutating func finish() -> [Event] {
    let wasActive = active
    self = SpeechGate()
    return wasActive ? [.end] : []
  }
}
