import AVFoundation
import CoreML
import DictationProtocol
import FluidAudio
import Foundation

@MainActor
private final class Recognition {
  private let models: AsrModels
  private var stream: SlidingWindowAsrManager?
  private var updates: WindowUpdates?
  private var updateTask: Task<Void, Never>?
  private var expectedWindows = 0
  private var schedule = WindowSchedule()
  private var utteranceId: String?
  private var spoken = false

  init(directory: URL) throws {
    // Unlike downloadAndLoad/load, loadLocal never consults a registry or downloads files.
    models = try AsrModels.loadLocal(from: directory, version: .v2)
  }

  private func makeStream() async throws -> SlidingWindowAsrManager {
    let config = SlidingWindowAsrConfig(
      chunkSeconds: 1.6, hypothesisChunkSeconds: 0.8,
      leftContextSeconds: 4.0, rightContextSeconds: 0.4,
      minContextForConfirmation: 4.0, confirmationThreshold: 0.85,
      tdtConfig: TdtConfig(blankId: 1024)
    )
    let engine = SlidingWindowAsrManager(config: config)
    try await engine.loadModels(models)
    try await engine.startStreaming()
    return engine
  }

  private nonisolated func buffer(_ samples: [Float]) throws -> sending AVAudioPCMBuffer {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
      let pcm = AVAudioPCMBuffer(
        pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = pcm.floatChannelData?[0]
    else { throw ProtocolError.invalidRequest }
    pcm.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      if let address = source.baseAddress { channel.update(from: address, count: source.count) }
    }
    return pcm
  }

  func warmup() async throws {
    // Load/compile and exercise the same inference path before advertising Listening.
    let engine = try await makeStream()
    let silence = [Float](
      repeating: 0, count: WindowSchedule.chunkSamples + WindowSchedule.rightSamples)
    await engine.streamAudio(try buffer(silence))
    _ = try await engine.finish()
    await engine.cancel()
  }

  func transcribe(_ request: AudioRequest) async throws -> String {
    let samples = try request.samples()
    if utteranceId != request.utteranceId {
      await stream?.cancel()
      stream = nil
      updateTask?.cancel()
      updates = nil
      expectedWindows = 0
      schedule = WindowSchedule()
      utteranceId = request.utteranceId
      spoken = false
    }
    if !spoken {
      let energy = samples.reduce(Float(0)) { $0 + $1 * $1 }
      spoken = !samples.isEmpty && sqrt(energy / Float(samples.count)) > 0.003
    }
    guard spoken else {
      if request.final { utteranceId = nil }
      return ""
    }
    if stream == nil {
      let engine = try await makeStream()
      let source = await engine.transcriptionUpdates
      let counter = WindowUpdates()
      updates = counter
      updateTask = Task.detached {
        for await _ in source { await counter.advance() }
      }
      stream = engine
    }
    guard let engine = stream else { throw ProtocolError.invalidRequest }
    expectedWindows += schedule.append(samples.count)
    if !samples.isEmpty { await engine.streamAudio(try buffer(samples)) }
    if request.final {
      let text = try await engine.finish()
      await engine.cancel()
      stream = nil
      updateTask?.cancel()
      updates = nil
      utteranceId = nil
      return text
    }
    await updates?.wait(until: expectedWindows)
    let confirmed = await engine.confirmedTranscript
    let volatile = await engine.volatileTranscript
    return [confirmed, volatile].filter { !$0.isEmpty }.joined(separator: " ")
  }
}

@main
struct CakeDictation {
  private static func reply(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
  }

  @MainActor
  static func main() async {
    // Recognized words must never enter console or unified debug logs.
    AppLogger.minimumLevel = .error
    AppLogger.mirrorsToConsole = false
    do {
      if CommandLine.arguments.dropFirst() == ["--version"] {
        try reply([
          "engine": "FluidAudio/CoreML", "version": "0.17.4", "minimumMacOS": "14.0",
          "protocolVersion": 1,
        ])
        return
      }
      guard CommandLine.arguments.count == 2 else { throw ProtocolError.invalidRequest }
      let recognition = try Recognition(
        directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true))
      try await recognition.warmup()
      try reply(["ready": true])
      for try await line in FileHandle.standardInput.bytes.lines {
        let request = try AudioRequest.decode(line)
        let text = try await recognition.transcribe(request)
        try reply(["text": text])
      }
    } catch {
      // An invalid request or failed inference ends this worker rather than reusing a
      // potentially inconsistent decoder. Main reports the failure and permits retry.
      try? reply(["error": error.localizedDescription])
      exit(1)
    }
  }
}
