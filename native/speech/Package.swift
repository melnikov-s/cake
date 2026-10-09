// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "CakeSpeech",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4", traits: []),
    ],
    targets: [
        .target(name: "SpeechTempo"),
        .executableTarget(
            name: "SpeechTempoTests", dependencies: ["SpeechTempo"],
            path: "Tests/SpeechTempoTests"
        ),
        .executableTarget(
            name: "cake-speech",
            dependencies: [
                "SpeechTempo",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ]
)
