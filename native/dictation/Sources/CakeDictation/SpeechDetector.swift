import CoreML
import DictationProtocol
import FluidAudio
import Foundation

/// One offline model, with caller-owned recurrent state for capture and recognition streams.
/// Never use VadManager's downloading initializer in the runtime helper.
actor SpeechDetector {
  private let manager: VadManager

  init(modelURL: URL) throws {
    let config = MLModelConfiguration()
    config.computeUnits = .cpuAndNeuralEngine
    let model = try MLModel(contentsOf: modelURL, configuration: config)
    manager = VadManager(config: VadConfig(defaultThreshold: 0.6), vadModel: model)
  }

  func classify(_ samples: [Float], state: VadStreamState) async throws -> VadStreamResult {
    guard !samples.isEmpty, samples.count <= SpeechGate.frameSamples else {
      throw ProtocolError.invalidRequest
    }
    let padded = samples + [Float](repeating: 0, count: SpeechGate.frameSamples - samples.count)
    // Use only recurrent model state; phrase/send hysteresis belongs to each consumer.
    return try await manager.processStreamingChunk(padded, state: state)
  }

}
