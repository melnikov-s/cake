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

  public static func decode(_ line: String) throws -> AudioRequest {
    guard line.utf8.count <= 855_000 else { throw ProtocolError.invalidRequest }
    let request = try JSONDecoder().decode(AudioRequest.self, from: Data(line.utf8))
    guard !request.utteranceId.isEmpty, request.utteranceId.utf8.count <= 400,
      request.pcm.utf8.count <= 854_000
    else { throw ProtocolError.invalidRequest }
    return request
  }

  public func samples() throws -> [Float] {
    guard let data = Data(base64Encoded: pcm), data.count % 4 == 0, data.count <= 640_000
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

/// Mirrors the pinned FluidAudio sliding-window scheduler. Awaiting each expected update
/// provides backpressure instead of feeding an unbounded AsyncStream of audio into Core ML.
public struct WindowSchedule: Sendable {
  public static let sampleRate = 16_000
  public static let chunkSamples = 25_600  // 1.6 seconds
  public static let rightSamples = 6_400  // 0.4 seconds lookahead
  private var received = 0
  private var processed = 0

  public init() {}

  public mutating func append(_ count: Int) -> Int {
    received += count
    let available = max(0, (received - Self.rightSamples) / Self.chunkSamples)
    let updates = max(0, available - processed)
    processed = available
    return updates
  }
}
