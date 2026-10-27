// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AnkiBase",
    platforms: [.iOS(.v17)],
    products: [.library(name: "AnkiBase", targets: ["AnkiBase"])],
    targets: [
        .target(
            name: "AnkiEngine",
            linkerSettings: [
                // Built by scripts/build.sh from engine/ (Anki's Rust library).
                .unsafeFlags(["-L", Context.packageDirectory + "/engine/target/aarch64-apple-ios/release"]),
                .linkedLibrary("ankibase_engine"),
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("CoreFoundation"),
            ]
        ),
        .target(
            name: "AnkiBase",
            dependencies: ["AnkiEngine"],
            resources: [.copy("Resources/web"), .copy("Resources/AppIcon.png")],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                // Match the installed SDK so iOS 26 gets its native look; iOS 17 and later run it.
                .unsafeFlags([
                    "-Xlinker", "-platform_version", "-Xlinker", "ios",
                    "-Xlinker", "17.0", "-Xlinker", "26.5",
                ])
            ]
        ),
    ]
)
