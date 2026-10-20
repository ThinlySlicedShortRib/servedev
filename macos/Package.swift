// swift-tools-version: 6.0
// The servedev menu bar app. `macos/build.sh` builds it and wraps it in an .app bundle.
import PackageDescription

let package = Package(
  name: "ServedevBar",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "ServedevBar",
      path: "Sources/ServedevBar",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
