import Foundation

public enum ProtocolError: Error, LocalizedError {
  case invalidRequest
  public var errorDescription: String? {
    "Invalid dictation request: expected bounded mono 16 kHz float32 PCM."
  }
}

public struct AudioRequest: Decodable, Sendable {
  public let utteranceId: String
  public let pcm: String
  public let final: Bool
  public let settings: SpeechRecognitionSettings?
  public let vocabulary: [VocabularyEntry]?

  public static func decode(_ line: String) throws -> AudioRequest {
    guard line.utf8.count <= 1_100_000 else { throw ProtocolError.invalidRequest }
    let request = try JSONDecoder().decode(AudioRequest.self, from: Data(line.utf8))
    guard !request.utteranceId.isEmpty, request.utteranceId.utf8.count <= 400,
      request.pcm.utf8.count <= 854_000
    else { throw ProtocolError.invalidRequest }
    try request.settings?.validate()
    guard (request.vocabulary?.count ?? 0) <= 100 else { throw ProtocolError.invalidRequest }
    for entry in request.vocabulary ?? [] { try entry.validate() }
    return request
  }

  public func samples() throws -> [Float] { try Self.decodeSamples(pcm) }

  public static func decodeSamples(_ pcm: String) throws -> [Float] {
    guard pcm.utf8.count <= 854_000,
      let data = Data(base64Encoded: pcm), data.count % 4 == 0, data.count <= 640_000
    else { throw ProtocolError.invalidRequest }
    return try data.withUnsafeBytes { bytes in
      try stride(from: 0, to: bytes.count, by: 4).map { offset in
        let bits = UInt32(
          littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
        let value = Float(bitPattern: bits)
        guard value.isFinite, abs(value) <= 1 else { throw ProtocolError.invalidRequest }
        return value
      }
    }
  }
}
