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

private func windowScheduleWaitsForLookaheadAndHandlesCoalescedAudio() throws {
  var schedule = WindowSchedule()
  try check(schedule.append(12_800) == 0, "First 800 ms waits")
  try check(schedule.append(12_800) == 0, "Right lookahead required")
  try check(schedule.append(12_800) == 1, "First model window")
  try check(schedule.append(12_800) == 0, "Next chunk still incomplete")
  try check(schedule.append(51_200) == 2, "Coalesced audio waits for every window")
  try check(schedule.append(0) == 0, "Empty flush adds no complete window")
  schedule = WindowSchedule()
  try check(schedule.append(31_999) == 0, "Exact boundary, before")
  try check(schedule.append(1) == 1, "Exact boundary, at")
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
    try check(audio == noise + voice, "Preroll preserves quiet speech onset")
  } else { throw TestFailure(message: "Expected speech onset") }
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
    try check(audio == [Float](repeating: 0, count: 4096) + voice,
      "Internal pause retains timing without passing background noise")
  } else { throw TestFailure(message: "Short pause must not split the phrase") }
  if case .end = gate.finish().first {} else { throw TestFailure(message: "Explicit finish flushes speech") }
  try check(gate.finish().isEmpty, "A second final flush is empty")
  if case .audio(let audio) = gate.append([0.001, 0.002], speech: true).first {
    try check(audio == [0.001, 0.002], "No stale preroll crosses a final boundary")
  } else { throw TestFailure(message: "Final partial frame must preserve short speech") }
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
  try check(deliveredSamples == 118 * voice.count, "Duration boundaries must not drop speech samples")
  if case .audio = gate.append(voice, speech: true).first {} else {
    throw TestFailure(message: "Speech continues in the next segment")
  }
}

@main
struct ProtocolTests {
  static func main() throws {
    try decodesMonoFloat32Audio()
    try rejectsMalformedOrUnboundedAudio()
    try windowScheduleWaitsForLookaheadAndHandlesCoalescedAudio()
    try gateIgnoresNoiseBeforeAndAfterSpeech()
    try gateRetainsInternalPausesAndFinalizesShortSpeech()
    try gateBoundsContinuousSpeech()
    print("Native dictation: 6 protocol and speech-boundary tests passed")
  }
}
