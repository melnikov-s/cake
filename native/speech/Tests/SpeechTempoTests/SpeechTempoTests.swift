import Foundation
import SpeechTempo

private func tone(seconds: Double, frequency: Double = 440) -> [Float] {
    (0..<Int(seconds * 24_000)).map { Float(0.5 * sin(2 * .pi * frequency * Double($0) / 24_000)) }
}

private func check(_ condition: Bool, _ message: String) {
    if !condition {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

private func rejects(_ operation: () throws -> [Float]) -> Bool {
    do { _ = try operation(); return false } catch { return true }
}

private func process(_ samples: [Float], speed: Double) throws -> [Float] {
    let tempo = try SpeechTempo(speed: speed)
    var result: [Float] = []
    for offset in stride(from: 0, to: samples.count, by: 1_920) {
        result += try tempo.append(Array(samples[offset..<min(offset + 1_920, samples.count)]))
    }
    result += try tempo.finish()
    return result
}

let normal = tone(seconds: 0.1)
check(try process(normal, speed: 1) == normal, "1x changes samples")
let streaming = try SpeechTempo(speed: 2)
var early: [Float] = []
for _ in 0..<8 { early += try streaming.append(tone(seconds: 0.08)) }
check(!early.isEmpty, "tempo buffers the whole phrase")
check(early.contains { abs($0) > 0.1 }, "early output is silent")
_ = try streaming.finish()
check(rejects { try streaming.append([0.1]) }, "append after finish accepted")
check(rejects { try streaming.finish() }, "duplicate finish accepted")

for speed in [1.01, 1.15, 1.2, 1.5, 2.0] {
    let samples = tone(seconds: 2)
    let result = try process(samples, speed: speed)
    check(result.count == Int(ceil(Double(samples.count) / speed)), "duration at \(speed)x")
    check(result.allSatisfy { $0.isFinite }, "nonfinite audio")
    let middle = Array(result[6_000..<18_000])
    let crossings = zip(middle, middle.dropFirst()).filter { $0 < 0 && $1 >= 0 }.count
    check(abs(crossings * 2 - 440) <= 6, "pitch changed at \(speed)x: \(crossings * 2) Hz")
    let rms = sqrt(middle.reduce(0.0) { $0 + Double($1 * $1) } / Double(middle.count))
    check(rms > 0.2 && rms < 0.5, "amplitude at \(speed)x: \(rms)")
    check(result.suffix(1_200).contains { abs($0) > 0.1 }, "silent tail at \(speed)x")
}
let ending = Array(repeating: Float(0), count: 45_600) + tone(seconds: 0.1)
let endingResult = try process(ending, speed: 2)
check(endingResult.suffix(1_200).contains { abs($0) > 0.1 }, "lost phrase ending")
let short = try process(normal, speed: 2)
check(short.count == 1_200, "short duration")
check(short.contains { abs($0) > 0.1 }, "short phrase inaudible")
for speed in [0.9, 2.01, Double.nan, Double.infinity] {
    check(rejects { try process([0.1], speed: speed) }, "invalid speed accepted")
}
check(rejects { try process([], speed: 1.2) }, "empty input accepted")
check(rejects { try process([.nan], speed: 1) }, "nonfinite input accepted")
print("SpeechTempo: incremental output, duration, pitch, amplitude, endings, 1x passthrough and validation passed")
