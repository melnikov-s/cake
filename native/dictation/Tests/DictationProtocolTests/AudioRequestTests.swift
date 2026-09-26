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

@main
struct ProtocolTests {
  static func main() throws {
    try decodesMonoFloat32Audio()
    try rejectsMalformedOrUnboundedAudio()
    try windowScheduleWaitsForLookaheadAndHandlesCoalescedAudio()
    print("Native dictation: 3 protocol tests passed")
  }
}
