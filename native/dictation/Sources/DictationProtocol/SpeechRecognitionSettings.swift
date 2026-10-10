import Foundation

/// Shared capture settings for dictation and voice mode. Voice-only send and
/// interruption policy never crosses into the native recognizer.
public struct SpeechRecognitionSettings: Codable, Sendable, Equatable {
  public let thresholds: SpeechThresholds
  public let minimumSpeechMs: Int
  public let prerollMs: Int
  public let maximumUtteranceSeconds: Int
  public static let standard = SpeechRecognitionSettings(
    thresholds: .standard, minimumSpeechMs: 200, prerollMs: 600, maximumUtteranceSeconds: 30)

  public init(thresholds: SpeechThresholds, minimumSpeechMs: Int, prerollMs: Int,
    maximumUtteranceSeconds: Int) {
    self.thresholds = thresholds
    self.minimumSpeechMs = minimumSpeechMs
    self.prerollMs = prerollMs
    self.maximumUtteranceSeconds = maximumUtteranceSeconds
  }

  public func validate() throws {
    try thresholds.validate()
    guard (100...1000).contains(minimumSpeechMs), (0...1000).contains(prerollMs),
      (5...60).contains(maximumUtteranceSeconds) else { throw ProtocolError.invalidRequest }
  }
}
