import CryptoKit
import FluidAudio
import Foundation
import SpeechTempo

private struct Request: Decodable {
    let text: String
    let voice: String
    let speed: Double
}

private struct Reply: Encodable {
    var ready: Bool?
    var pcm: String?
    var done: Bool?
    var error: String?
}

private struct Manifest: Decodable {
    struct File: Decodable {
        let path: String
        let bytes: Int
        let sha256: String
    }
    let modelDirectory: String
    let files: [File]
}

private func failure(_ message: String) -> NSError {
    NSError(domain: "CakeSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private func emit(_ reply: Reply) throws {
    var data = try JSONEncoder().encode(reply)
    data.append(0x0a)
    try FileHandle.standardOutput.write(contentsOf: data)
}

/// Validate the complete pinned installation before calling FluidAudio's cache loader.
/// All required graphs, constants, the BOS backfill and Alba are present, so neither
/// initialize nor makeSession can enter its downloader. No voices/cloning are exposed.
private func validateInstallation(_ directory: URL, manifestURL: URL) throws {
    let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
    guard manifest.modelDirectory == "Models/pocket-tts-coreml/v2.1/english",
          !manifest.files.isEmpty else {
        throw failure("Invalid local speech installation manifest.")
    }
    let languageRoot = directory.appendingPathComponent(manifest.modelDirectory)
    for file in manifest.files {
        let components = file.path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              file.bytes > 0 else {
            throw failure("Invalid local speech asset path.")
        }
        let data = try Data(contentsOf: languageRoot.appendingPathComponent(file.path), options: .mappedIfSafe)
        guard data.count == file.bytes,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == file.sha256 else {
            throw failure("Local speech model is incomplete or corrupt. Download it again in Settings.")
        }
    }
}

private func emitSamples(_ samples: [Float]) throws -> Bool {
    guard samples.allSatisfy({ $0.isFinite }) else {
        throw failure("Local model returned invalid audio.")
    }
    var audible = false
    for offset in stride(from: 0, to: samples.count, by: 16_384) {
        var data = Data(capacity: 32_768)
        for sample in samples[offset..<min(offset + 16_384, samples.count)] {
            var pcm = Int16((max(-1, min(1, sample)) * 32_767).rounded()).littleEndian
            audible = audible || abs(Int(pcm)) > 3
            withUnsafeBytes(of: &pcm) { data.append(contentsOf: $0) }
        }
        try emit(Reply(pcm: data.base64EncodedString()))
    }
    return audible
}

private func run() async throws {
    // Upstream informational logs can contain source text. Never mirror or retain them.
    AppLogger.minimumLevel = .error
    AppLogger.mirrorsToConsole = false
    guard CommandLine.arguments.count == 3 else {
        throw failure("Expected a local model directory and bundled manifest.")
    }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try validateInstallation(directory, manifestURL: URL(fileURLWithPath: CommandLine.arguments[2]))
    // Keep Mimi on CPU as upstream recommends; avoid ANE graph failures on some
    // supported Macs without implementing a hidden retry or provider fallback.
    let manager = PocketTtsManager(directory: directory, precision: .fp16, computeUnits: .avoidNeuralEngine)
    try await manager.initialize()
    try emit(Reply(ready: true))
    while let line = readLine() {
        do {
            let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
            guard !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  request.text.utf16.count <= 2_000, request.voice == "alba",
                  request.speed.isFinite, (1...2).contains(request.speed) else {
                throw failure("Invalid speech request.")
            }
            let tempo = try SpeechTempo(speed: request.speed)
            let session = try await manager.makeSession(voice: request.voice)
            session.enqueue(request.text)
            session.finish()
            var audible = false
            do {
                for try await frame in session.frames {
                    let output = try tempo.append(frame.samples)
                    audible = try emitSamples(output) || audible
                }
                audible = try emitSamples(tempo.finish()) || audible
                guard audible else { throw failure("Local model returned silent audio.") }
            } catch {
                await session.cancel()
                throw error
            }
            try emit(Reply(done: true))
        } catch {
            try emit(Reply(error: "Local speech generation failed. Exit and re-enter voice mode to retry."))
        }
    }
}

do {
    try await run()
} catch {
    try? emit(Reply(error: "Could not load the local speech engine or Pocket TTS model. Download the Core ML model in Settings."))
    exit(1)
}
