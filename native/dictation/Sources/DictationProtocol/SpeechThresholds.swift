import Foundation

/// Capture-local probability hysteresis shared by dictation and voice mode.
public struct SpeechThresholds: Codable, Sendable, Equatable {
  public let start: Float
  public let continuation: Float
  public static let standard = SpeechThresholds(start: 0.6, continuation: 0.4)

  public init(start: Float, continuation: Float) {
    self.start = start
    self.continuation = continuation
  }

  public func validate() throws {
    guard start.isFinite, continuation.isFinite,
      (0.05...0.95).contains(start), (0.05...0.95).contains(continuation),
      continuation <= start else { throw ProtocolError.invalidRequest }
  }

  public func isSpeech(_ probability: Float, previouslySpeaking: Bool) -> Bool {
    probability >= (previouslySpeaking ? continuation : start)
  }
}
