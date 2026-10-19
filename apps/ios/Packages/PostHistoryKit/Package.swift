// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PostHistoryKit",
    defaultLocalization: "ar",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PostHistoryAPI", targets: ["PostHistoryAPI"]),
        .library(name: "AuthCore", targets: ["AuthCore"]),
    ],
    targets: [
        // عميل API مولَّد من contracts/openapi.yaml عبر scripts/generate-api.sh؛ لا يُعدَّل يدويًا.
        .target(name: "PostHistoryAPI", path: "Sources/PostHistoryAPI"),
        // الهوية: دخول/تحديث/إبطال حسب العقد، الرموز في Keychain، معترض يضيف Bearer ويحدّث عند 401.
        .target(name: "AuthCore", dependencies: ["PostHistoryAPI"]),
        .testTarget(name: "AuthCoreTests", dependencies: ["AuthCore"]),
    ]
)
