import Foundation
import MLX
import MLXAudioTTS
import MLXNN

// Serialized local-only NDJSON protocol. Model and voice files are supplied by Cake;
// never use fromPretrained or a runtime download API here.
private struct Request: Decodable {
    let text: String
    let voice: String
}

private struct Reply: Encodable {
    var ready: Bool?
    var pcm: String?
    var done: Bool?
    var error: String?
}

private struct QuantizationConfig: Decodable {
    struct Quantization: Decodable {
        let bits: Int
        let group_size: Int
        let mode: String
    }
    let quantization: Quantization
}

private func emit(_ reply: Reply) throws {
    var data = try JSONEncoder().encode(reply)
    data.append(0x0a)
    try FileHandle.standardOutput.write(contentsOf: data)
}

private func loadModel(_ directory: URL) async throws -> PocketTTSModel {
    let configURL = directory.appendingPathComponent("config.json")
    let quantization = try JSONDecoder().decode(
        QuantizationConfig.self, from: Data(contentsOf: configURL)
    ).quantization
    guard quantization.bits == 8, quantization.group_size == 64,
          quantization.mode == "affine" else {
        throw NSError(domain: "CakeSpeech", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Expected the Pocket TTS 8-bit model.",
        ])
    }
    let config = try PocketTTSModelConfig.load(from: configURL)
    let model = try await PocketTTSModel.fromConfig(config, modelFolder: directory)
    var weights = try MLX.loadArrays(url: directory.appendingPathComponent("model.safetensors"))
    // QuantizedEmbedding in this MLX release cannot process the zero-token
    // conditioning calls Pocket uses between frames. Expand only the small
    // lookup table in memory, preserving the checkpoint's quantized values.
    let embedding = "flow_lm.conditioner.embed"
    if let weight = weights["\(embedding).weight"], let scales = weights["\(embedding).scales"] {
        weights["\(embedding).weight"] = dequantized(
            weight, scales: scales, biases: weights["\(embedding).biases"],
            groupSize: 64, bits: 8, mode: .affine
        )
        weights.removeValue(forKey: "\(embedding).scales")
        weights.removeValue(forKey: "\(embedding).biases")
    }
    // Upstream Pocket's Swift loader only handles unquantized weights. Match the
    // published checkpoint exactly, including its quantized embeddings/codec layers.
    let replacements: [(String, Module)] = model.leafModules().flattened().compactMap { path, layer in
        if weights["\(path).scales"] != nil {
            guard let replacement = quantizeSingle(layer: layer, groupSize: 64, bits: 8, mode: .affine) else {
                return nil
            }
            return (path, replacement)
        }
        // Preserve every member of FlowLM's heterogeneous Module arrays:
        // MLX 0.31.3 cannot replace a sparse array beginning with nil, and a
        // partial replacement drops trailing unquantized normalization layers.
        if path.hasPrefix("flow_lm.flow_net."),
           path.range(of: #"\.(mlp|adaLN_modulation)\.[0-9]+$"#, options: .regularExpression) != nil {
            return (path, layer)
        }
        return nil
    }
    try model.update(modules: ModuleChildren.unflattened(replacements), verify: .none)
    try model.update(parameters: ModuleParameters.unflattened(weights), verify: .all)
    eval(model)
    return model
}

private func run() async throws {
    guard CommandLine.arguments.count == 2 else {
        throw NSError(domain: "CakeSpeech", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Expected a local model directory.",
        ])
    }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let model = try await loadModel(directory)
    guard model.sampleRate == 24_000 else {
        throw NSError(domain: "CakeSpeech", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "Expected 24 kHz speech output.",
        ])
    }
    try emit(Reply(ready: true))
    while let line = readLine() {
        do {
            let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
            guard !request.text.isEmpty, request.text.count <= 2_000,
                  request.voice == "alba" else {
                throw NSError(domain: "CakeSpeech", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Invalid speech request.",
                ])
            }
            let audio = try await model.generate(
                text: request.text,
                voice: request.voice,
                generationParameters: model.defaultGenerationParameters
            )
            let samples = audio.asArray(Float.self)
            guard !samples.isEmpty, samples.allSatisfy({ $0.isFinite }) else {
                throw NSError(domain: "CakeSpeech", code: 5, userInfo: [
                    NSLocalizedDescriptionKey: "Local model returned invalid audio.",
                ])
            }
            // Upstream currently generates an entire phrase before returning it.
            // Emit bounded PCM frames compatible with Cake's existing playback path.
            for offset in stride(from: 0, to: samples.count, by: 16_384) {
                var data = Data(capacity: 32_768)
                for sample in samples[offset..<min(offset + 16_384, samples.count)] {
                    var pcm = Int16((max(-1, min(1, sample)) * 32_767).rounded()).littleEndian
                    withUnsafeBytes(of: &pcm) { data.append(contentsOf: $0) }
                }
                try emit(Reply(pcm: data.base64EncodedString()))
            }
            try emit(Reply(done: true))
            Memory.clearCache()
        } catch {
            // Do not include text or raw model/provider diagnostics in protocol errors.
            try emit(Reply(error: "Local speech generation failed. Exit and re-enter voice mode to retry."))
        }
    }
}

do {
    try await run()
} catch {
    try? emit(Reply(error: "Could not load the local speech engine or Pocket TTS model."))
    exit(1)
}
