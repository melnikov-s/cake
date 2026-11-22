import CoreML
import DictationProtocol
import FluidAudio
import Foundation

/// Models are loaded on first use; audio and the reference belong only to the active round.
/// Core ML inference runs on this actor, separate from capture and the ASR decoder.
actor FirstSpeakerFilter {
  private let segmentation: MLModel
  private let embeddings: EmbeddingExtractor
  private var speaker = FirstSpeaker()
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

  func reset() { speaker = FirstSpeaker() }

  func approved(_ window: SpeakerWindows.Window) throws -> [Float] {
    let audio = window.audio
    let range = window.output
    // Digital silence does not warrant two model calls; ambient audio is still assessed.
    if audio.allSatisfy({ $0 == 0 }) { return [Float](repeating: 0, count: range.count) }
    let padded = audio + [Float](repeating: 0, count: sampleCount - audio.count)
    let frames = try classify(padded, frames: frameIndex(audio.count - 1) + 1)
    let first = frameIndex(range.lowerBound)
    let end = frameIndex(range.upperBound - 1) + 1
    var policy = speaker
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
    return range.map { index in
      guard case .single(let label) = frames[frameIndex(index)], matched.contains(label) else {
        return 0
      }
      return audio[index]
    }
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
      guard let best = probabilities.indices.max(by: { probabilities[$0] < probabilities[$1] }),
        probabilities[best] >= 0.55,
        probabilities[4...6].reduce(0, +) < 0.25
      else { return .uncertain }
      switch best {
      case 0: return .silence
      case 1...3: return .single(best - 1)
      default: return .uncertain
      }
    }
  }
}
