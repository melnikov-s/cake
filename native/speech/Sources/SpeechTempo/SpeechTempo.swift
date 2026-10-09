import AVFoundation

/// Incremental, pitch-preserving tempo processing with no audio device. One engine
/// spans all model frames in a phrase; never independently stretch 80ms fragments.
/// At 1x PCM passes through unchanged. Faster rates retain only 8192 input samples
/// of lookahead (~341ms), not the entire phrase. finish() flushes the exact duration.
public final class SpeechTempo {
    private let speed: Double
    private let format: AVAudioFormat
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var output: AVAudioPCMBuffer?
    private var inputCount = 0
    private var outputCount = 0
    private var finished = false
    private let lookahead = 8_192

    public init(speed: Double) throws {
        guard speed.isFinite, (1...2).contains(speed) else {
            throw Self.failure("Invalid local speech tempo rate.")
        }
        self.speed = speed
        self.format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
        if speed == 1 { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let tempo = AVAudioUnitTimePitch()
        tempo.rate = Float(speed)
        tempo.pitch = 0
        engine.attach(player)
        engine.attach(tempo)
        engine.connect(player, to: tempo, format: format)
        engine.connect(tempo, to: engine.mainMixerNode, format: format)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4_096)
        guard let output = AVAudioPCMBuffer(
            pcmFormat: engine.manualRenderingFormat,
            frameCapacity: engine.manualRenderingMaximumFrameCount
        ) else { throw Self.failure("Could not allocate local speech tempo output.") }
        self.engine = engine
        self.player = player
        self.output = output
        // Start only after the first buffer is scheduled.
    }

    deinit {
        player?.stop()
        engine?.stop()
        engine?.disableManualRenderingMode()
    }

    public func append(_ samples: [Float]) throws -> [Float] {
        guard !finished, !samples.isEmpty, samples.allSatisfy({ $0.isFinite }) else {
            throw Self.failure("Invalid local speech tempo input.")
        }
        inputCount += samples.count
        if speed == 1 { return samples }
        guard let player, let engine, let input = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)
        ), let inputData = input.floatChannelData else {
            throw Self.failure("Could not allocate local speech audio.")
        }
        input.frameLength = input.frameCapacity
        samples.withUnsafeBufferPointer { source in
            inputData[0].update(from: source.baseAddress!, count: samples.count)
        }
        player.scheduleBuffer(input)
        if !engine.isRunning {
            try engine.start()
            player.play()
        }
        let available = max(0, Int(floor(Double(inputCount - lookahead) / speed)))
        return try render(until: available)
    }

    public func finish() throws -> [Float] {
        guard !finished, inputCount > 0 else {
            throw Self.failure("Invalid local speech tempo completion.")
        }
        finished = true
        if speed == 1 { return [] }
        return try render(until: Int(ceil(Double(inputCount) / speed)))
    }

    private func render(until target: Int) throws -> [Float] {
        guard let engine, let output else { throw Self.failure("Local speech tempo stopped.") }
        var result: [Float] = []
        result.reserveCapacity(max(0, target - outputCount))
        while outputCount < target {
            let frames = AVAudioFrameCount(min(Int(output.frameCapacity), target - outputCount))
            let status = try engine.renderOffline(frames, to: output)
            guard status == .success, output.frameLength > 0, let data = output.floatChannelData else {
                throw Self.failure("Could not render local speech tempo.")
            }
            result.append(contentsOf: UnsafeBufferPointer(start: data[0], count: Int(output.frameLength)))
            outputCount += Int(output.frameLength)
        }
        guard result.allSatisfy({ $0.isFinite }) else {
            throw Self.failure("Invalid local speech tempo output.")
        }
        return result
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "CakeSpeechTempo", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
