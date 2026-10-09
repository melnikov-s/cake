// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "CakeSpeech",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/Blaizzy/mlx-audio-swift.git",
            revision: "b917ab5486cdb0dde9ca2c1b7a55821796856be2"
        ),
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.3"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", exact: "3.31.3"),
    ],
    targets: [
        .target(name: "SpeechTempo"),
        // Standalone runner works with Command Line Tools without XCTest/Swift Testing.
        // It is never copied into Cake's application bundle.
        .executableTarget(
            name: "SpeechTempoTests", dependencies: ["SpeechTempo"],
            path: "Tests/SpeechTempoTests"
        ),
        .executableTarget(
            name: "cake-speech",
            dependencies: [
                "SpeechTempo",
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
            ]
        ),
    ]
)
