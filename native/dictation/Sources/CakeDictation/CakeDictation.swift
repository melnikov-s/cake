import AVFoundation
import CoreML
import DictationProtocol
import FluidAudio
import Foundation

private struct Operation: Decodable {
  let operation: String
}
private struct DetectionRequest: Decodable {
  let captureId: String
  let pcm: String
}

@MainActor
private final class Recognition {
  private let models: AsrModels
  private let detector: SpeechDetector
  private var stream: SlidingWindowAsrManager?
  private var updates: WindowUpdates?
  private var updateTask: Task<Void, Never>?
  private var expectedWindows = 0
  private var schedule = WindowSchedule()
  private var utteranceId: String?
  private var gate = SpeechGate()
  private var pendingSamples: [Float] = []
  private var completed: [String] = []
  private var recognitionState = VadStreamState.initial()
  private var recognitionSpeech = false
  private var captureId: String?
  private var captureState = VadStreamState.initial()
  private var captureSpeech = false

  init(directory: URL, vadURL: URL) throws {
    models = try AsrModels.loadLocal(from: directory, version: .v2)
    detector = try SpeechDetector(modelURL: vadURL)
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
      let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = pcm.floatChannelData?[0]
    else { throw ProtocolError.invalidRequest }
    pcm.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      if let address = source.baseAddress { channel.update(from: address, count: source.count) }
    }
    return pcm
  }

  func warmup() async throws {
    let engine = try await makeStream()
    await engine.streamAudio(try buffer([Float](
      repeating: 0, count: WindowSchedule.chunkSamples + WindowSchedule.rightSamples)))
    _ = try await engine.finish()
    await engine.cancel()
    // Exercise the detector before advertising readiness, with a throwaway recurrent state.
    _ = try await detector.classify(
      [Float](repeating: 0.00001, count: SpeechGate.frameSamples), state: .initial())
  }

  func detect(_ line: String) async throws -> Bool {
    guard line.utf8.count <= 23_000 else { throw ProtocolError.invalidRequest }
    let request = try JSONDecoder().decode(DetectionRequest.self, from: Data(line.utf8))
    guard !request.captureId.isEmpty, request.captureId.utf8.count <= 400 else {
      throw ProtocolError.invalidRequest
    }
    let samples = try AudioRequest.decodeSamples(request.pcm)
    if captureId != request.captureId {
      captureId = request.captureId
      captureState = .initial()
      captureSpeech = false
    }
    let result = try await detector.classify(samples, state: captureState)
    captureState = result.state
    captureSpeech = SpeechDetector.isSpeech(result.probability, previouslySpeaking: captureSpeech)
    return captureSpeech
  }

  private func cancelStream() async {
    await stream?.cancel()
    stream = nil
    updateTask?.cancel()
    updateTask = nil
    updates = nil
    expectedWindows = 0
    schedule = WindowSchedule()
  }

  private func consume(_ events: [SpeechGate.Event]) async throws {
    for event in events {
      switch event {
      case .audio(let samples):
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
        await engine.streamAudio(try buffer(samples))
        await updates?.wait(until: expectedWindows)
      case .end:
        if let engine = stream {
          // Explicit submission can arrive immediately after the last syllable. Supply
          // right lookahead as silence instead of requiring room noise to finish words.
          await engine.streamAudio(try buffer([Float](repeating: 0, count: WindowSchedule.rightSamples)))
          let text = try await engine.finish()
          if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { completed.append(text) }
        }
        await cancelStream()
      }
    }
  }

  private func classifyRecognition(_ samples: [Float]) async throws {
    let result = try await detector.classify(samples, state: recognitionState)
    recognitionState = result.state
    recognitionSpeech = SpeechDetector.isSpeech(
      result.probability, previouslySpeaking: recognitionSpeech)
    try await consume(gate.append(samples, speech: recognitionSpeech))
  }

  func transcribe(_ request: AudioRequest) async throws -> String {
    let samples = try request.samples()
    if utteranceId != request.utteranceId {
      await cancelStream()
      utteranceId = request.utteranceId
      gate = SpeechGate()
      pendingSamples = []
      completed = []
      recognitionState = .initial()
      recognitionSpeech = false
    }
    pendingSamples.append(contentsOf: samples)
    while pendingSamples.count >= SpeechGate.frameSamples {
      let frame = Array(pendingSamples.prefix(SpeechGate.frameSamples))
      pendingSamples.removeFirst(SpeechGate.frameSamples)
      try await classifyRecognition(frame)
    }
    if request.final {
      if !pendingSamples.isEmpty { try await classifyRecognition(pendingSamples) }
      pendingSamples = []
      try await consume(gate.finish())
      utteranceId = nil
    }
    let confirmed = await stream?.confirmedTranscript ?? ""
    let volatile = await stream?.volatileTranscript ?? ""
    // Every result is a full replacement, not a delta. Finished phrases are appended exactly once.
    return (completed + [confirmed, volatile]).filter { !$0.isEmpty }.joined(separator: " ")
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
    AppLogger.minimumLevel = .error
    AppLogger.mirrorsToConsole = false
    do {
      if CommandLine.arguments.dropFirst() == ["--version"] {
        try reply([
          "engine": "FluidAudio/CoreML", "version": "0.17.4", "minimumMacOS": "14.0",
          "protocolVersion": 2,
        ])
        return
      }
      guard CommandLine.arguments.count == 3 else { throw ProtocolError.invalidRequest }
      let recognition = try Recognition(
        directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true),
        vadURL: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
      try await recognition.warmup()
      try reply(["ready": true])
      for try await line in FileHandle.standardInput.bytes.lines {
        guard line.utf8.count <= 855_000 else { throw ProtocolError.invalidRequest }
        let operation = try JSONDecoder().decode(Operation.self, from: Data(line.utf8))
        switch operation.operation {
        case "transcribe":
          try reply(["text": try await recognition.transcribe(AudioRequest.decode(line))])
        case "detectSpeech":
          try reply(["speech": try await recognition.detect(line)])
        default: throw ProtocolError.invalidRequest
        }
      }
    } catch {
      try? reply(["error": error.localizedDescription])
      exit(1)
    }
  }
}
