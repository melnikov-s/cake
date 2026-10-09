import AVFoundation

/// Offline, pitch-preserving tempo adjustment. No audio device or network is opened.
/// Pocket currently supplies a whole phrase, so processing precedes bounded PCM emission.
public enum SpeechTempo {
    public static func adjust(_ samples: [Float], speed: Double) throws -> [Float] {
        guard speed.isFinite, (1...2).contains(speed),
              !samples.isEmpty, samples.allSatisfy({ $0.isFinite }) else {
            throw failure("Invalid local speech tempo input.")
        }
        if speed == 1 { return samples }

        let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
        guard let input = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)
        ), let inputData = input.floatChannelData else {
            throw failure("Could not allocate local speech audio.")
        }
        input.frameLength = input.frameCapacity
        samples.withUnsafeBufferPointer { source in
            inputData[0].update(from: source.baseAddress!, count: samples.count)
        }

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
        defer {
            player.stop()
            engine.stop()
            engine.disableManualRenderingMode()
        }
        player.scheduleBuffer(input)
        try engine.start()
        player.play()

        guard let output = AVAudioPCMBuffer(
            pcmFormat: engine.manualRenderingFormat,
            frameCapacity: engine.manualRenderingMaximumFrameCount
        ) else {
            throw failure("Could not allocate local speech tempo output.")
        }
        let count = Int(ceil(Double(samples.count) / speed))
        var result: [Float] = []
        result.reserveCapacity(count)
        while result.count < count {
            let frames = AVAudioFrameCount(min(Int(output.frameCapacity), count - result.count))
            let status = try engine.renderOffline(frames, to: output)
            guard status == .success, output.frameLength > 0,
                  let data = output.floatChannelData else {
                throw failure("Could not render local speech tempo.")
            }
            result.append(contentsOf: UnsafeBufferPointer(
                start: data[0], count: Int(output.frameLength)
            ))
        }
        guard result.allSatisfy({ $0.isFinite }) else {
            throw failure("Invalid local speech tempo output.")
        }
        return result
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "CakeSpeechTempo", code: 1, userInfo: [
            NSLocalizedDescriptionKey: message,
        ])
    }
}
