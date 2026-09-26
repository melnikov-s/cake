// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "CakeDictation",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "cake-dictation", targets: ["CakeDictation"]),
    .executable(name: "dictation-protocol-tests", targets: ["DictationProtocolTests"]),
  ],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4", traits: [])
  ],
  targets: [
    .target(name: "DictationProtocol"),
    .executableTarget(
      name: "CakeDictation",
      dependencies: ["DictationProtocol", .product(name: "FluidAudio", package: "FluidAudio")]
    ),
    // A tiny standalone test runner also works with Command Line Tools, which don't ship
    // XCTest/Swift Testing. This executable is never included in Cake's application bundle.
    .executableTarget(
      name: "DictationProtocolTests", dependencies: ["DictationProtocol"],
      path: "Tests/DictationProtocolTests"),
  ]
)
