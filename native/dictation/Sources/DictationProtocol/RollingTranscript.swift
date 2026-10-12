import Foundation

public struct RecognizedWord: Sendable {
  public let text: String
  public let startSample: Int
  public let endSample: Int

  public init(text: String, startSample: Int, endSample: Int) {
    self.text = text
    self.startSample = startSample
    self.endSample = endSample
  }

  fileprivate var midpoint: Int { startSample + (endSample - startSample) / 2 }
  fileprivate var core: String {
    text.trimmingCharacters(in: .punctuationCharacters).lowercased()
  }
}

/// Capture-local audio and hypotheses. Thinking pauses do not seal text. Re-decode the
/// whole bounded window with fresh decoder state, not just the newly arrived samples.
/// Punctuation participates in agreement, and the newest six seconds remain revisable.
public struct RollingTranscript: Sendable {
  public static let sampleRate = 16_000
  // Leave room for 400 ms of endpoint lookahead within Parakeet's 15-second model input.
  public static let maximumSamples = 14 * sampleRate
  public static let revisionSamples = 6 * sampleRate
  public static let contextSamples = 2 * sampleRate
  public private(set) var audio: [Float] = []
  public private(set) var startSample = 0
  private var confirmed = ""
  private var anchor: RecognizedWord?
  private var boundary = 0
  private var previous: [RecognizedWord] = []
  private var pending: [RecognizedWord] = []

  public init() {}
  public var remainingSamples: Int { Self.maximumSamples - audio.count }
  public var text: String {
    ([confirmed] + pending.map(\.text)).filter { !$0.isEmpty }.joined(separator: " ")
  }

  public mutating func append(_ samples: [Float]) throws {
    guard samples.count <= remainingSamples else { throw ProtocolError.invalidRequest }
    audio.append(contentsOf: samples)
  }

  /// Timings are absolute on this window's speech-audio timeline, not wall-clock time.
  /// Budget pressure commits old words even if they disagree; it never commits the recent
  /// tail. Normal updates require two matching hypotheses, including case/punctuation.
  public mutating func update(_ words: [RecognizedWord], atCapacity: Bool = false) {
    var current = words
    if let anchor {
      // Retained left context must not be emitted twice. Match the last committed word
      // near its acoustic time; genuine spoken repetitions later in time remain intact.
      let matches = current.indices.filter {
        current[$0].core == anchor.core
          && abs(current[$0].startSample - anchor.startSample) <= Self.sampleRate / 2
      }
      if let match = matches.min(by: {
        abs(current[$0].startSample - anchor.startSample)
          < abs(current[$1].startSample - anchor.startSample)
      }) {
        current = Array(current.dropFirst(match + 1))
      } else {
        current = current.filter { $0.midpoint > boundary }
      }
    }
    let cutoff = startSample + audio.count - Self.revisionSamples
    var common = 0
    while common < min(previous.count, current.count),
      previous[common].text == current[common].text
    {
      common += 1
    }
    let eligible = current.prefix { $0.endSample <= cutoff }.count
    // Always leave at least one word revisable; the following word's start gives a
    // safe seam for trimming audio without cutting the next word in half.
    let count = min(atCapacity ? eligible : min(common, eligible), max(0, current.count - 1))
    if count > 0 {
      let settled = current.prefix(count)
      let addition = settled.map(\.text).joined(separator: " ")
      confirmed = confirmed.isEmpty ? addition : confirmed + " " + addition
      anchor = current[count - 1]
      boundary = (current[count - 1].endSample + current[count].startSample) / 2
      current.removeFirst(count)
    }
    pending = current
    previous = current
    var trimTo = max(startSample, (anchor?.startSample ?? boundary) - Self.contextSamples)
    if atCapacity {
      // Empty/leading unrecognized audio can be discarded, but retain context before
      // the earliest uncommitted word even when its timestamp spans the cutoff.
      let firstPending = current.first?.startSample ?? cutoff
      trimTo = max(trimTo, min(cutoff, firstPending) - Self.contextSamples)
    }
    let drop = max(0, min(audio.count, trimTo - startSample))
    audio.removeFirst(drop)
    startSample += drop
  }
}
