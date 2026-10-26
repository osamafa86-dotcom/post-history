import Foundation
import os
import DeviceAttestation
import PostHistoryAPI
import UploadCore

/// سجل آمن: معرّفات ومراحل فقط. لا أسماء ملفات ولا مسارات ولا رموز ولا إحداثيات في أي سطر.
enum SafeLog {
    static let uploads = Logger(subsystem: "net.palpost.posthistory", category: "uploads")
    static func phase(_ id: UUID, _ phase: UploadPhase) {
        uploads.info("upload \(id.uuidString, privacy: .public) phase \(String(String(describing: phase).prefix(24)), privacy: .public)")
    }
}

/// الخدمات المشتركة بين التطبيق ومفوَّض الجلسة الخلفية (الذي يُستدعى قبل بناء الواجهة).
final class UploadServices: @unchecked Sendable {
    static let shared = UploadServices()
    static let backgroundSessionIdentifier = "net.palpost.posthistory.uploads"

    let transport: URLSessionTusTransport
    let documentsDirectory: URL
    let uploadsDirectory: URL
    let chunksDirectory: URL
    let stateDirectory: URL
    /// مسودات «مادة جديدة» (المواصفة A1)؛ يمحوها المسح الطارئ.
    let draftsDirectory: URL

    private init() {
        let config = URLSessionConfiguration.background(withIdentifier: Self.backgroundSessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true
        transport = URLSessionTusTransport(configuration: config)
        transport.unmeteredOnly = { UserDefaults.standard.bool(forKey: AppSettings.uploadOverWifiOnlyKey) }
        documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        uploadsDirectory = documentsDirectory.appendingPathComponent("Uploads", isDirectory: true)
        chunksDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("UploadChunks", isDirectory: true)
        stateDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("UploadState", isDirectory: true)
        draftsDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Drafts", isDirectory: true)
        for dir in [uploadsDirectory, chunksDirectory, stateDirectory, draftsDirectory] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: UploadFileProtection.attributes)
            // الملفات المحلية للمراسل وحالة الرفع (تحمل رابط tus) لا تدخل النسخ الاحتياطي (iCloud/iTunes).
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = dir
            try? url.setResourceValues(values)
        }
    }

    func makeEngine(api: PostHistoryAPIAPIConfiguration) throws -> UploadEngine {
        var env = UploadEngine.Environment()
        env.documentsDirectory = documentsDirectory
        env.isBackground = { true } // جزء كبير افتراضيًا: الرفع يستمر بعد خروج التطبيق إلى الخلفية
        return UploadEngine(store: try FileUploadStateStore(directory: stateDirectory), secrets: KeychainUploadSecretStore(), api: GeneratedUploadAPI(configuration: api),
                            transport: transport, ingestTokens: Self.makeIngestTokens(api: api),
                            slicer: ChunkSlicer(chunksDirectory: chunksDirectory), environment: env)
    }

    /// رمز بوابة ingest (SEC-07) عبر App Attest. على المحاكي والأجهزة بلا App Attest يرفض المصدر فيفشل الرفع خلف البوابة
    /// بـ «الجهاز لا يستطيع إثبات نفسه»؛ الجلسات التي لا يضعها الخادم خلف البوابة لا تطلبه أصلًا.
    static func makeIngestTokens(api: PostHistoryAPIAPIConfiguration) -> any IngestTokenProvider {
        #if os(iOS)
        let backend: any AppAttestBackend = DeviceCheckAppAttestBackend()
        #else
        let backend: any AppAttestBackend = UnsupportedAppAttestBackend()
        #endif
        return AppAttestIngestTokenProvider(backend: backend, api: GeneratedAttestationAPI(configuration: api), keys: KeychainAttestationKeyStore())
    }

    /// ينسخ الملف المختار إلى مجلد الرفع ويعيد مساره النسبي (الأصل كما هو؛ لا تحويل).
    func importFile(from source: URL, preferredName: String) throws -> (relativePath: String, size: Int64) {
        let ext = source.pathExtension.isEmpty ? "bin" : source.pathExtension
        let name = "\(UUID().uuidString.lowercased()).\(ext)"
        let target = uploadsDirectory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: source, to: target)
        let size = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
        return ("Uploads/\(name)", size)
    }

    func deleteLocalCopy(relativePath: String) {
        try? FileManager.default.removeItem(at: documentsDirectory.appendingPathComponent(relativePath))
    }

    func localCopyExists(relativePath: String) -> Bool {
        FileManager.default.fileExists(atPath: documentsDirectory.appendingPathComponent(relativePath).path)
    }
}

/// إعدادات المراسل. حذف النسخة المحلية بعد الإيصال اختياري (قرار المالك) وافتراضيه الإبقاء مع تذكير بارز.
/// «عبر Wi‑Fi فقط» اختياري وافتراضيه الرفع على أي شبكة؛ تغييره يعيد جدولة النقل الجاري بالسياسة الجديدة.
@MainActor
final class AppSettings: ObservableObject {
    nonisolated static let uploadOverWifiOnlyKey = "uploadOverWifiOnly"

    @Published var deleteLocalAfterReceipt: Bool {
        didSet { UserDefaults.standard.set(deleteLocalAfterReceipt, forKey: "deleteLocalAfterReceipt") }
    }
    @Published var uploadOverWifiOnly: Bool {
        didSet {
            guard uploadOverWifiOnly != oldValue else { return }
            UserDefaults.standard.set(uploadOverWifiOnly, forKey: Self.uploadOverWifiOnlyKey)
            Task { await UploadServices.shared.transport.restartTransfers() }
        }
    }
    nonisolated static let localCopyHandledKey = "localCopyHandled"
    /// مواد حسم المراسل نسختها المحلية من شاشة الإيصال («حذف» أو «إبقاؤها»)؛ لا تعود بطاقة السؤال لها.
    @Published private(set) var localCopyHandled: Set<UUID> = []

    init() {
        deleteLocalAfterReceipt = UserDefaults.standard.bool(forKey: "deleteLocalAfterReceipt")
        uploadOverWifiOnly = UserDefaults.standard.bool(forKey: Self.uploadOverWifiOnlyKey)
        localCopyHandled = Set((UserDefaults.standard.stringArray(forKey: Self.localCopyHandledKey) ?? []).compactMap(UUID.init))
    }

    func reload() {
        deleteLocalAfterReceipt = UserDefaults.standard.bool(forKey: "deleteLocalAfterReceipt")
        uploadOverWifiOnly = UserDefaults.standard.bool(forKey: Self.uploadOverWifiOnlyKey)
        localCopyHandled = Set((UserDefaults.standard.stringArray(forKey: Self.localCopyHandledKey) ?? []).compactMap(UUID.init))
    }

    func markLocalCopyHandled(_ materialId: UUID) {
        localCopyHandled.insert(materialId)
        UserDefaults.standard.set(localCopyHandled.map(\.uuidString), forKey: Self.localCopyHandledKey)
    }
}
