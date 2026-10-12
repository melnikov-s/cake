import DictationProtocol
import Foundation

private struct TestFailure: Error { let message: String }
private func check(_ value: Bool, _ message: String) throws {
  if !value { throw TestFailure(message: message) }
}
private func rejects(_ work: () throws -> Void) throws {
  var rejected = false
  do { try work() } catch { rejected = true }
  try check(rejected, "Expected invalid request to be rejected")
}
private func request(_ values: [Float], final: Bool = false) throws -> AudioRequest {
  let pcm = values.withUnsafeBytes { Data($0).base64EncodedString() }
  return try AudioRequest.decode(
    "{\"utteranceId\":\"focus-1\",\"pcm\":\"\(pcm)\",\"final\":\(final)}")
}

private func decodesMonoFloat32Audio() throws {
  let value = try request([0, 0.5, -0.5, 1, -1], final: true)
  try check(value.samples() == [0, 0.5, -0.5, 1, -1], "Float32 samples round trip")
  try check(value.final, "Final request flag survives decoding")
  try check(request([]).samples().isEmpty, "Empty final flush is valid")
}

private func rejectsMalformedOrUnboundedAudio() throws {
  for pcm in ["not-base64", "AA=="] {
    try rejects {
      _ = try AudioRequest.decode("{\"utteranceId\":\"x\",\"pcm\":\"\(pcm)\",\"final\":false}")
        .samples()
    }
  }
  for value: Float in [.nan, .infinity, 2] { try rejects { _ = try request([value]).samples() } }
  try rejects { _ = try request([Float](repeating: 0, count: 160_001)).samples() }
  try rejects { _ = try AudioRequest.decode("{\"utteranceId\":\"\",\"pcm\":\"\",\"final\":false}") }
}

private func gateIgnoresNoiseBeforeAndAfterSpeech() throws {
  var gate = SpeechGate()
  let noise = [Float](repeating: 0.5, count: 4096)
  for _ in 0..<20 {
    try check(gate.append(noise, speech: false).isEmpty, "Loud non-speech never starts recognition")
  }
  let voice = [Float](repeating: 0.001, count: 4096)
  let onset = gate.append(voice, speech: true)
  if case .audio(let audio) = onset.first {
    try check(
      audio == [Float](repeating: 0.5, count: 9600) + voice,
      "Shared 600 ms lookback preserves quiet speech onset")
  } else {
    throw TestFailure(message: "Expected speech onset")
  }
  try check(gate.append(noise, speech: false).count == 1, "Preserve one tail frame")
  for _ in 0..<4 {
    try check(gate.append(noise, speech: false).isEmpty, "No new windows from long room noise")
  }
  let end = gate.append(noise, speech: false)
  if case .end = end.first {} else { throw TestFailure(message: "Pause finalizes the phrase") }
  for _ in 0..<20 {
    try check(gate.append(noise, speech: false).isEmpty, "Noise after speech remains excluded")
  }
  try check(gate.finish().isEmpty, "Finishing an already completed phrase is not duplicated")
}

private func gateRetainsInternalPausesAndFinalizesShortSpeech() throws {
  var gate = SpeechGate()
  let voice = [Float](repeating: 0.1, count: 4096)
  let noise = [Float](repeating: 0.3, count: 4096)
  _ = gate.append(voice, speech: true)
  _ = gate.append(noise, speech: false)
  try check(gate.append(noise, speech: false).isEmpty, "Hold quiet frames pending resumed speech")
  if case .audio(let audio) = gate.append(voice, speech: true).first {
    try check(
      audio == [Float](repeating: 0, count: 4096) + voice,
      "Internal pause retains timing without passing background noise")
  } else {
    throw TestFailure(message: "Short pause must not split the phrase")
  }
  if case .end = gate.finish().first {
  } else {
    throw TestFailure(message: "Explicit finish flushes speech")
  }
  try check(gate.finish().isEmpty, "A second final flush is empty")
  try check(
    gate.append([0.001, 0.002], speech: true).isEmpty,
    "Speech shorter than the shared minimum does not start recognition")
  _ = gate.finish()
  if case .audio(let audio) = gate.append(voice, speech: true).first {
    try check(audio == voice, "No stale preroll or candidate crosses a final boundary")
  } else {
    throw TestFailure(message: "Short qualifying speech is retained")
  }
}

private func gateBoundsContinuousSpeech() throws {
  var gate = SpeechGate()
  let voice = [Float](repeating: 0.1, count: 4096)
  var ended = false
  var deliveredSamples = 0
  for _ in 0..<118 {
    for event in gate.append(voice, speech: true) {
      switch event {
      case .end: ended = true
      case .audio(let audio): deliveredSamples += audio.count
      }
    }
  }
  try check(ended, "Long speech must finalize a bounded segment")
  try check(
    deliveredSamples == 118 * voice.count, "Duration boundaries must not drop speech samples")
  if case .audio = gate.append(voice, speech: true).first {
  } else {
    throw TestFailure(message: "Speech continues in the next segment")
  }
}

private func thresholdHysteresisPreservesDefaultsAndAllowsStricterCapture() throws {
  let standard = SpeechThresholds.standard
  let strict = SpeechThresholds(start: 0.85, continuation: 0.7)
  try standard.validate()
  try strict.validate()
  try check(
    standard.isSpeech(0.7, previouslySpeaking: false),
    "The default onset threshold accepts ordinary speech")
  try check(
    !strict.isSpeech(0.7, previouslySpeaking: false),
    "Stricter shared detection rejects ambiguous noise")
  try check(strict.isSpeech(0.9, previouslySpeaking: false), "Confident speech is still accepted")
  try check(
    strict.isSpeech(0.75, previouslySpeaking: true),
    "Continuation uses its lower hysteresis threshold")
  try check(
    !strict.isSpeech(0.65, previouslySpeaking: true), "Speech ends below continuation threshold")
  for invalid in [
    SpeechThresholds(start: .nan, continuation: 0.4),
    SpeechThresholds(start: 1, continuation: 0.4), SpeechThresholds(start: 0.6, continuation: 0),
    SpeechThresholds(start: 0.4, continuation: 0.6),
  ] {
    try rejects { try invalid.validate() }
  }
}

private func sharedGateSettingsPreserveOnsetAndBoundContinuousSegments() throws {
  let settings = SpeechRecognitionSettings(
    thresholds: .standard, minimumSpeechMs: 1000,
    prerollMs: 0, maximumUtteranceSeconds: 5)
  try settings.validate()
  var gate = SpeechGate(settings: settings)
  let voice = [Float](repeating: 0.1, count: 4096)
  let noise = [Float](repeating: 0.7, count: 4096)
  for _ in 0..<3 {
    try check(gate.append(voice, speech: true).isEmpty, "Brief onset remains tentative")
  }
  try check(gate.append(noise, speech: false).isEmpty, "Noise breaks the minimum-speech window")
  for _ in 0..<3 {
    try check(
      gate.append(voice, speech: true).isEmpty, "A broken onset cannot qualify later speech early")
  }
  if case .audio(let audio) = gate.append(voice, speech: true).first {
    try check(
      audio == [Float](repeating: 0.1, count: 4 * 4096),
      "Zero lookback preserves all qualifying onset frames, not noise")
  } else {
    throw TestFailure(message: "One second of sustained speech starts recognition")
  }
  var segments = 0
  for _ in 0..<16 {
    for event in gate.append(voice, speech: true) { if case .end = event { segments += 1 } }
  }
  try check(segments == 1, "Shared five-second cap finalizes a native segment")
  _ = gate.finish()
  try check(
    gate.append(voice, speech: true).isEmpty,
    "Finishing retains the configured minimum for the next segment")
}

private func sharedLookbackAndSettingsDecodeAreValidated() throws {
  let settings = SpeechRecognitionSettings(
    thresholds: SpeechThresholds(start: 0.85, continuation: 0.5),
    minimumSpeechMs: 500, prerollMs: 300, maximumUtteranceSeconds: 5)
  let data = try JSONEncoder().encode(settings)
  let json = String(decoding: data, as: UTF8.self)
  let request = try AudioRequest.decode(
    "{\"utteranceId\":\"tuned\",\"pcm\":\"\",\"final\":false,\"settings\":\(json)}")
  try check(request.settings == settings, "Recognition requests carry all shared settings")
  var gate = SpeechGate(settings: settings)
  let noise = [Float](repeating: 0.5, count: 4096)
  let voice = [Float](repeating: 0.1, count: 4096)
  for _ in 0..<4 { _ = gate.append(noise, speech: false) }
  try check(gate.append(voice, speech: true).isEmpty, "Minimum duration also applies with lookback")
  if case .audio(let audio) = gate.append(voice, speech: true).first {
    try check(
      audio == [Float](repeating: 0.5, count: 4800) + voice + voice,
      "Configured lookback is exact and onset remains intact")
  } else {
    throw TestFailure(message: "Expected sustained speech")
  }
  for invalid in [
    SpeechRecognitionSettings(
      thresholds: .standard, minimumSpeechMs: 99, prerollMs: 300, maximumUtteranceSeconds: 5),
    SpeechRecognitionSettings(
      thresholds: .standard, minimumSpeechMs: 500, prerollMs: 1001, maximumUtteranceSeconds: 5),
    SpeechRecognitionSettings(
      thresholds: .standard, minimumSpeechMs: 500, prerollMs: 300, maximumUtteranceSeconds: 4),
  ] {
    let json = String(decoding: try JSONEncoder().encode(invalid), as: UTF8.self)
    try rejects {
      _ = try AudioRequest.decode(
        "{\"utteranceId\":\"bad\",\"pcm\":\"\",\"final\":false,\"settings\":\(json)}")
    }
  }
}

@main
struct ProtocolTests {
  static func main() throws {
    try decodesMonoFloat32Audio()
    try rejectsMalformedOrUnboundedAudio()
    try rollingTranscriptTests()
    try gateIgnoresNoiseBeforeAndAfterSpeech()
    try gateRetainsInternalPausesAndFinalizesShortSpeech()
    try gateBoundsContinuousSpeech()
    try thresholdHysteresisPreservesDefaultsAndAllowsStricterCapture()
    try sharedGateSettingsPreserveOnsetAndBoundContinuousSegments()
    try sharedLookbackAndSettingsDecodeAreValidated()
    print("Native dictation: protocol, speech-boundary and rolling-revision tests passed")
  }
}
