import CoreML
import DictationProtocol
import FluidAudio
import Foundation

/// Models are prepared before filtered capture; audio and the reference belong only to the active round.
/// Core ML inference runs on this actor, separate from capture and the ASR decoder.
actor FirstSpeakerFilter {
  private let segmentation: MLModel
  private let embeddings: EmbeddingExtractor
  private var speaker = FirstSpeaker()
  /// One flag per retained sample, aligned with SpeakerWindows' left history.
  private var approvedHistory: [Bool] = []
  private let sampleCount = 160_000
  private let frameCount = 589

  init(directory: URL) throws {
    let config = MLModelConfiguration()
    config.computeUnits = .cpuAndNeuralEngine
    let segmentURL = directory.appendingPathComponent("pyannote_segmentation.mlmodelc")
    let embeddingURL = directory.appendingPathComponent("wespeaker_v2.mlmodelc")
    segmentation = try MLModel(contentsOf: segmentURL, configuration: config)
    embeddings = EmbeddingExtractor(embeddingModel: try MLModel(contentsOf: embeddingURL, configuration: config))
  }

  func warmup() throws {
    // A short, deterministic non-speech probe exercises the same fixed-shape predictions as
    // a real first window. Explicit activity bypasses the embedding extractor's inactive-mask
    // shortcut, regardless of the segmentation result. Neither output enters FirstSpeaker.
    let audio = (0..<24_576).map { sample in
      Float(0.02) * sin(Float(sample) * 0.1)
    }
    let frames = frameIndex(audio.count - 1) + 1
    _ = try classify(audio + [Float](repeating: 0, count: sampleCount - audio.count), frames: frames)
    let mask = [Float](repeating: 1, count: frames) + [Float](repeating: 0, count: frameCount - frames)
    guard let embedding = try embeddings.getEmbeddings(audio: audio, masks: [mask]).first,
      embedding.allSatisfy({ $0.isFinite }), embedding.contains(where: { $0 != 0 })
    else { throw ProtocolError.invalidRequest }
  }

  func reset() {
    speaker = FirstSpeaker()
    approvedHistory = []
  }

  func approved(_ window: SpeakerWindows.Window) throws -> [Float] {
    let range = window.output
    if range.lowerBound == 0 { approvedHistory = [] }
    let (audio, verified) = try filter(window)
    approvedHistory = Array((approvedHistory + verified).suffix(SpeakerWindows.recoveryHistory))
    return audio
  }

  private func filter(_ window: SpeakerWindows.Window) throws -> ([Float], [Bool]) {
    let range = window.output
    let shortStart = max(0, range.lowerBound - SpeakerWindows.context)
    let audio = Array(window.audio.dropFirst(shortStart))
    // Digital silence does not warrant two model calls; ambient audio is still assessed.
    if audio.allSatisfy({ $0 == 0 }) {
      return (Array(repeating: 0, count: range.count), Array(repeating: false, count: range.count))
    }
    let frames = try classifyWindow(audio)
    let first = frameIndex(range.lowerBound - shortStart)
    let end = frameIndex(range.upperBound - 1 - shortStart) + 1
    var policy = speaker
    let wasLocked = policy.isLocked
    let matched = try policy.allowedLabels(frames, from: first, until: end) { label in
      var mask = [Float](repeating: 0, count: frameCount)
      var count = 0
      for i in frames.indices where frames[i] == .single(label) {
        mask[i] = 1
        count += 1
      }
      guard count >= FirstSpeaker.minimumMatch else { return nil }
      // Use FluidAudio's repeat padding for WeSpeaker's fixed 10 s input. Zero padding
      // biases short-window embeddings toward a shared silence signature.
      return try embeddings.getEmbeddings(audio: audio, masks: [mask]).first
    }
    speaker = policy
    var recovery: (frames: [FirstSpeaker.Frame], label: Int)?
    if wasLocked, matched.isEmpty, shortStart > 0,
      let label = FirstSpeaker.isolatedLabel(frames, within: first..<end)
    {
      recovery = try recover(window, shortStart: shortStart, shortFrames: frames, label: label)
    }
    var verified = [Bool](repeating: false, count: range.count)
    let output = range.map { index -> Float in
      guard case .single(let label) = frames[frameIndex(index - shortStart)] else { return 0 }
      if matched.contains(label) {
        verified[index - range.lowerBound] = true
        return window.audio[index]
      }
      if let recovery, recovery.frames[frameIndex(index)] == .single(recovery.label) {
        return window.audio[index]
      }
      return 0
    }
    // A recovered burst must never become evidence for recovering another burst.
    return (output, verified)
  }

  private func recover(
    _ window: SpeakerWindows.Window, shortStart: Int, shortFrames: [FirstSpeaker.Frame], label: Int
  ) throws -> (frames: [FirstSpeaker.Frame], label: Int)? {
    let range = window.output
    guard approvedHistory.count == range.lowerBound else { return nil }
    let audio = window.audio
    let frames = try classifyWindow(audio)
    let first = frameIndex(range.lowerBound)
    let end = frameIndex(range.upperBound - 1) + 1
    // Segmentation labels are local to each inference. The short analysis must see
    // this burst alone and the longer analysis must see one track, with no overlap.
    let tracks = Set(frames.compactMap { frame -> Int? in
      if case .single(let track) = frame { return track }
      return nil
    })
    guard !frames.contains(.overlap), tracks.count == 1, let track = tracks.first
    else { return nil }
    var support = 0
    var burst = 0
    var speech: [Float] = []
    for i in frames.indices where frames[i] == .single(track) {
      let lo = 495 + i * FirstSpeaker.frameStep - FirstSpeaker.frameStep / 2
      let hi = min(lo + FirstSpeaker.frameStep, audio.count)
      guard lo < hi else { continue }
      let center = (lo + hi) / 2
      if hi <= range.lowerBound, approvedHistory[center] {
        support += 1
      } else if lo >= range.lowerBound,
        shortFrames[frameIndex(center - shortStart)] == .single(label)
      {
        burst += 1
      } else { continue }
      speech.append(contentsOf: audio[lo..<hi])
    }
    guard support >= 48, burst >= FirstSpeaker.minimumMatch else { return nil }  // ~810 ms of verified context
    // Remove the pause from the embedding input, not from the emitted waveform. A
    // sparse mask pools speech but cannot remove silence from WeSpeaker's normalization.
    var policy = speaker
    let matched = try policy.allowedLabels(frames, from: first, until: end) { _ in
      try embeddings.getEmbeddings(audio: speech, masks: [[Float](repeating: 1, count: frameCount)]).first
    }
    return matched.contains(track) ? (frames, track) : nil
  }

  private func classifyWindow(_ audio: [Float]) throws -> [FirstSpeaker.Frame] {
    try classify(audio + [Float](repeating: 0, count: sampleCount - audio.count),
      frames: frameIndex(audio.count - 1) + 1)
  }

  /// Map waveform samples to the nearest frame center (991-sample receptive field,
  /// 270-sample stride); edges use the first or last available prediction.
  private func frameIndex(_ sample: Int) -> Int {
    max(0, (sample - 495 + FirstSpeaker.frameStep / 2) / FirstSpeaker.frameStep)
  }

  private func classify(_ audio: [Float], frames: Int) throws -> [FirstSpeaker.Frame] {
    let waveform = try MLMultiArray(shape: [1, 1, 160_000], dataType: .float32)
    waveform.withUnsafeMutableBufferPointer(ofType: Float.self) { destination, _ in
      audio.withUnsafeBufferPointer { _ = destination.update(from: $0) }
    }
    let input = try MLDictionaryFeatureProvider(dictionary: ["audio": waveform])
    let output = try segmentation.prediction(from: input)
    guard let scores = output.featureValue(for: "segments")?.multiArrayValue,
      scores.shape.map(\.intValue) == [1, frameCount, 7]
    else { throw ProtocolError.invalidRequest }
    return (0..<frames).map { frame in
      // pyannote's powerset log probabilities: silence, three singles, three pairs.
      let probabilities = (0..<7).map { exp(scores[[0, NSNumber(value: frame), NSNumber(value: $0)]].floatValue) }
      if probabilities[4...6].reduce(0, +) >= 0.25 { return .overlap }
      guard let best = probabilities.indices.max(by: { probabilities[$0] < probabilities[$1] }),
        probabilities[best] >= 0.55
      else { return .uncertain }
      switch best {
      case 0: return .silence
      case 1...3: return .single(best - 1)
      default: return .uncertain
      }
    }
  }
}
