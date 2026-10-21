// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PostHistoryKit",
    defaultLocalization: "ar",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PostHistoryAPI", targets: ["PostHistoryAPI"]),
        .library(name: "AuthCore", targets: ["AuthCore"]),
        .library(name: "UploadCore", targets: ["UploadCore"]),
        .library(name: "FormEngine", targets: ["FormEngine"]),
        .library(name: "DeviceSecurity", targets: ["DeviceSecurity"]),
        .library(name: "MaterialsCore", targets: ["MaterialsCore"]),
        .library(name: "DeviceAttestation", targets: ["DeviceAttestation"]),
        .library(name: "NotificationsCore", targets: ["NotificationsCore"]),
        .executable(name: "form-conformance", targets: ["form-conformance"]),
        .executable(name: "upload-netlab", targets: ["upload-netlab"]),
    ],
    dependencies: [
        // SHA-256 على Linux (الاختبارات وCI)؛ على منصات Apple يُستخدم CryptoKit.
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.10.0"),
    ],
    targets: [
        // عميل API مولَّد من contracts/openapi.yaml عبر scripts/generate-api.sh؛ لا يُعدَّل يدويًا.
        .target(name: "PostHistoryAPI", path: "Sources/PostHistoryAPI"),
        // الهوية: دخول/تحديث/إبطال حسب العقد، الرموز في Keychain، معترض يضيف Bearer ويحدّث عند 401.
        .target(name: "AuthCore", dependencies: ["PostHistoryAPI"]),
        .testTarget(name: "AuthCoreTests", dependencies: ["AuthCore"]),
        // نواة الرفع: tus 1.0 عبر URLSession خلفية بأجزاء كبيرة، استئناف من آخر جزء مؤكد، بصمة SHA-256، انتظار الإيصال.
        .target(name: "UploadCore", dependencies: ["PostHistoryAPI", .product(name: "Crypto", package: "swift-crypto")]),
        .testTarget(name: "UploadCoreTests", dependencies: ["UploadCore"]),
        // راسم النماذج: التحقق المشترك (form-conformance) وقيم الحقول؛ الواجهة في App/.
        .target(name: "FormEngine", dependencies: ["PostHistoryAPI"]),
        .testTarget(name: "FormEngineTests", dependencies: ["FormEngine"]),
        .executableTarget(name: "form-conformance", dependencies: ["FormEngine"]),
        // عميل قياس netlab: يشغّل نواة الرفع نفسها على Linux ضد tusd عبر toxiproxy ويطبع ملخص الجلسة لـ tools/netlab/netlab.py --client-cmd.
        .executableTarget(name: "upload-netlab", dependencies: ["UploadCore", "PostHistoryAPI"]),
        // أمان الجهاز (SEC-01، جانب الجهاز): المسح الطارئ بخطوات مرتبة وتقرير بما مُسح وما تعذّر، دون تسجيل مسارات.
        .target(name: "DeviceSecurity"),
        .testTarget(name: "DeviceSecurityTests", dependencies: ["DeviceSecurity"]),
        // «موادي»: قائمة مواد المراسل بصفحات وحالاتها الثلاث المستقلة كما في العقد؛ الواجهة في App/.
        .target(name: "MaterialsCore", dependencies: ["PostHistoryAPI"]),
        .testTarget(name: "MaterialsCoreTests", dependencies: ["MaterialsCore"]),
        // شهادة الجهاز (SEC-07): App Attest ورمز بوابة ingest لكل جلسة رفع؛ التدفق يُختبر على Linux بمحاكاة DCAppAttestService.
        .target(name: "DeviceAttestation", dependencies: ["UploadCore", "PostHistoryAPI", .product(name: "Crypto", package: "swift-crypto")]),
        .testTarget(name: "DeviceAttestationTests", dependencies: ["DeviceAttestation"]),
        // الإشعارات: تسجيل رمز APNs بمعرّف تثبيت مولَّد، وصندوق الإشعارات مع القراءة والإقرار، وتوجيه حمولة الدفع.
        .target(name: "NotificationsCore", dependencies: ["PostHistoryAPI"]),
        .testTarget(name: "NotificationsCoreTests", dependencies: ["NotificationsCore"]),
    ]
)
