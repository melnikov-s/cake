import DictationProtocol
import FluidAudio
import Foundation

private struct Operation: Decodable {
  let operation: String
}
private struct EndRoundRequest: Decodable {
  let speakerRoundId: String
}
private struct DetectionRequest: Decodable {
  let captureId: String
  let pcm: String
  let thresholds: SpeechThresholds?
}

@MainActor
private final class Recognition {
  private let engine: AsrManager
  private let detector: SpeechDetector
  private let boosting: VocabularyBoosting
  private var speaker: FirstSpeakerFilter?
  private let speakerDirectory: URL
  private var speakerRoundId: String?
  private var speakerWindows = SpeakerWindows()
  private var transcript = RollingTranscript()
  private var newSamples = 0
  private var decodeDue = false
  private var utteranceId: String?
  private var settings = SpeechRecognitionSettings.standard
  private var gate = SpeechGate()
  private var pendingSamples: [Float] = []
  private var recognitionState = VadStreamState.initial()
  private var recognitionSpeech = false
  private var captureId: String?
  private var captureState = VadStreamState.initial()
  private var captureSpeech = false
  private let lookaheadSamples = 6_400

  init(directory: URL, vadURL: URL, vocabularyURL: URL) throws {
    boosting = VocabularyBoosting(directory: vocabularyURL)
    let models = try AsrModels.loadLocal(from: directory, version: .v2)
    engine = AsrManager(config: ASRConfig(tdtConfig: TdtConfig(blankId: 1024)), models: models)
    detector = try SpeechDetector(modelURL: vadURL)
    speakerDirectory = vadURL.deletingLastPathComponent().appendingPathComponent("speaker")
  }

  func warmup() async throws {
    var state = TdtDecoderState.make()
    _ = try await engine.transcribe([Float](repeating: 0, count: 12_800), decoderState: &state)
    _ = try await detector.classify(
      [Float](repeating: 0.00001, count: SpeechGate.frameSamples), state: .initial())
  }

  func prepareVocabulary() async throws { try await boosting.prepare() }

  func detect(_ line: String) async throws -> Bool {
    guard line.utf8.count <= 23_000 else { throw ProtocolError.invalidRequest }
    let request = try JSONDecoder().decode(DetectionRequest.self, from: Data(line.utf8))
    guard !request.captureId.isEmpty, request.captureId.utf8.count <= 400 else {
      throw ProtocolError.invalidRequest
    }
    let samples = try AudioRequest.decodeSamples(request.pcm)
    let thresholds = request.thresholds ?? .standard
    try thresholds.validate()
    if captureId != request.captureId {
      captureId = request.captureId
      captureState = .initial()
      captureSpeech = false
    }
    let result = try await detector.classify(samples, state: captureState)
    captureState = result.state
    captureSpeech = thresholds.isSpeech(result.probability, previouslySpeaking: captureSpeech)
    return captureSpeech
  }

  private func decode(atCapacity: Bool = false, endpoint: Bool = false) async throws {
    guard !transcript.audio.isEmpty else { return }
    var audio = transcript.audio
    if endpoint { audio.append(contentsOf: [Float](repeating: 0, count: lookaheadSamples)) }
    // Parakeet requires at least 300 ms, including for an immediately submitted short command.
    if audio.count < 4_800 {
      audio.append(contentsOf: [Float](repeating: 0, count: 4_800 - audio.count))
    }
    // Fresh state permits revisions anywhere in the window, including punctuation from a
    // previous thinking pause. Carrying decoder tokens would freeze those old decisions.
    var state = TdtDecoderState.make()
    let result = try await engine.transcribe(audio, decoderState: &state)
    guard let timings = result.tokenTimings else {
      throw ASRError.processingFailed("The speech model did not return token timings.")
    }
    let words = buildWordTimings(from: timings).map { word in
      RecognizedWord(
        text: word.word,
        startSample: transcript.startSample + Int(word.startTime * 16_000),
        endSample: transcript.startSample + Int(word.endTime * 16_000))
    }
    let corrections = try await boosting.corrections(
      text: result.text, timings: timings, audio: audio, words: words)
    transcript.update(
      applyingVocabularyCorrections(corrections, to: words), atCapacity: atCapacity, endpoint: endpoint)
    newSamples = 0
    decodeDue = false
  }

  private func consume(_ events: [SpeechGate.Event]) async throws {
    for event in events {
      switch event {
      case .audio(let samples):
        var offset = 0
        while offset < samples.count {
          if transcript.remainingSamples == 0 {
            try await decode(atCapacity: true)
            guard transcript.remainingSamples > 0 else { throw ProtocolError.invalidRequest }
          }
          let count = min(samples.count - offset, transcript.remainingSamples)
          try transcript.append(Array(samples[offset..<(offset + count)]))
          offset += count
          newSamples += count
        }
      case .end:
        // An audio endpoint is a chance to improve the hypothesis, not a text commit.
        // Quiet room noise remains excluded; the recent audio survives until speech resumes.
        decodeDue = true
      }
    }
  }

  private func classifyRecognition(_ samples: [Float]) async throws {
    let result = try await detector.classify(samples, state: recognitionState)
    recognitionState = result.state
    recognitionSpeech = settings.thresholds.isSpeech(
      result.probability, previouslySpeaking: recognitionSpeech)
    try await consume(gate.append(samples, speech: recognitionSpeech))
  }

  private func resetSpan() {
    utteranceId = nil
    transcript = RollingTranscript()
    gate = SpeechGate(settings: settings)
    newSamples = 0
    decodeDue = false
    pendingSamples = []
    recognitionState = .initial()
    recognitionSpeech = false
    speakerWindows = SpeakerWindows()
  }

  func endRound(_ id: String) async throws {
    try AudioRequest.validateID(id)
    guard speakerRoundId == id else { return }
    speakerRoundId = nil
    resetSpan()
    await speaker?.reset()
  }

  /// Acknowledge only after both real predictions succeed. Existing warm models and live
  /// speaker/ASR state are left alone when another capture asks for preparation.
  func prepareSpeaker() async throws -> Bool {
    if speaker != nil { return true }
    let filter = try FirstSpeakerFilter(directory: speakerDirectory)
    try await filter.warmup()
    speaker = filter
    return false
  }

  private func consumePCM(_ samples: [Float]) async throws {
    pendingSamples.append(contentsOf: samples)
    while pendingSamples.count >= SpeechGate.frameSamples {
      let frame = Array(pendingSamples.prefix(SpeechGate.frameSamples))
      pendingSamples.removeFirst(SpeechGate.frameSamples)
      try await classifyRecognition(frame)
    }
  }

  func transcribe(_ request: AudioRequest) async throws -> (text: String, speakerPassedSpeech: Bool?) {
    let filter: FirstSpeakerFilter?
    if request.speakerRoundId != nil {
      guard let speaker else { throw ProtocolError.invalidRequest }
      filter = speaker
    } else {
      filter = nil
    }
    let samples = try request.samples()
    let requestedSettings = request.settings ?? .standard
    if speakerRoundId != request.speakerRoundId {
      speakerRoundId = request.speakerRoundId
      resetSpan()
      await speaker?.reset()
    }
    if utteranceId != request.utteranceId {
      // Vocabulary revisions take effect on the next utterance, never halfway through
      // an already committed rolling transcript.
      try await boosting.configure(request.vocabulary ?? [])
      settings = requestedSettings
      resetSpan()
      utteranceId = request.utteranceId
    } else if requestedSettings != settings {
      throw ProtocolError.invalidRequest
    }
    var speakerPassedSpeech: Bool?
    if let filter {
      speakerPassedSpeech = false
      try speakerWindows.append(samples)
      var previous: [Float] = []
      while let window = speakerWindows.next(final: request.final) {
        // At most one speaker prediction in flight while recognition consumes the
        // previous approved window. No unverified PCM is passed to the recognizer.
        async let approved = filter.approved(window)
        try await consumePCM(previous)
        previous = try await approved
        if speakerPassedSpeech == false && previous.contains(where: { $0 != 0 }) {
          speakerPassedSpeech = true
        }
      }
      try await consumePCM(previous)
    } else {
      try await consumePCM(samples)
    }
    if request.final {
      if !pendingSamples.isEmpty { try await classifyRecognition(pendingSamples) }
      pendingSamples = []
      try await consume(gate.finish())
    }
    if request.final || decodeDue || newSamples >= 12_800 {
      try await decode(endpoint: request.final || decodeDue)
    }
    let text = transcript.text
    if request.final {
      // Explicit finalization releases capture-local audio, including the retained overlap.
      resetSpan()
    }
    // Every result is a full replacement. The renderer owns and protects the spoken insertion.
    return (text, speakerPassedSpeech)
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
          "protocolVersion": 5,
        ])
        return
      }
      guard CommandLine.arguments.count == 4 else { throw ProtocolError.invalidRequest }
      let recognition = try Recognition(
        directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true),
        vadURL: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true),
        vocabularyURL: URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true))
      try await recognition.warmup()
      try reply(["ready": true])
      for try await line in FileHandle.standardInput.bytes.lines {
        guard line.utf8.count <= 1_100_000 else { throw ProtocolError.invalidRequest }
        let operation = try JSONDecoder().decode(Operation.self, from: Data(line.utf8))
        switch operation.operation {
        case "prepareVocabulary":
          try await recognition.prepareVocabulary()
          try reply(["prepared": true])
        case "prepareSpeaker":
          let reused = try await recognition.prepareSpeaker()
          try reply(["speakerPrepared": true, "reused": reused])
        case "transcribe":
          let result = try await recognition.transcribe(AudioRequest.decode(line))
          var response: [String: Any] = ["text": result.text]
          if let passed = result.speakerPassedSpeech { response["speakerPassedSpeech"] = passed }
          try reply(response)
        case "detectSpeech":
          try reply(["speech": try await recognition.detect(line)])
        case "endRound":
          let request = try JSONDecoder().decode(EndRoundRequest.self, from: Data(line.utf8))
          try await recognition.endRound(request.speakerRoundId)
          try reply(["roundEnded": true])
        default: throw ProtocolError.invalidRequest
        }
      }
    } catch {
      try? reply(["error": error.localizedDescription])
      exit(1)
    }
  }
}
