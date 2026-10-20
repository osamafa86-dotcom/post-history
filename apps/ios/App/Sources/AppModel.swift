import AuthCore
import DeviceSecurity
import Foundation
import PostHistoryAPI
import SwiftUI
import UploadCore

/// تركيب الطبقات: عميل API مولَّد بمعترض الهوية، وجلسة الهوية فوق Keychain.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn(StoredSession), revoked(at: Date), wiped(WipeReport) }

    @Published private(set) var phase: Phase = .loading

    let auth: AuthSession
    /// إعداد العميل لكل المسارات المصادَق عليها (يضيف Bearer ويحدّث عند 401).
    let api: PostHistoryAPIAPIConfiguration
    let settings = AppSettings()
    let uploads: UploadQueueModel
    private var authWatcher: Task<Void, Never>?

    init(store: any TokenStore = KeychainTokenStore(), baseURL: String = AppConfiguration.apiBaseURL) {
        // Keychain يبقى بعد حذف التطبيق: أول تشغيل بعد تثبيت جديد يمسح جلسة مستخدم سابق (العلامة تُحذف مع التطبيق).
        if !UserDefaults.standard.bool(forKey: "hasLaunchedBefore") {
            try? store.clear()
            try? KeychainUploadSecretStore().removeAll()
            UserDefaults.standard.set(true, forKey: "hasLaunchedBefore")
        }
        // مسارات /auth/* بلا معترض كي لا يدخل التحديث في حلقة.
        let plain = PostHistoryAPIAPIConfiguration(basePath: baseURL)
        let auth = AuthSession(store: store, gateway: APIAuthGateway(configuration: plain))
        self.auth = auth
        let api = PostHistoryAPIAPIConfiguration(basePath: baseURL, interceptor: AuthInterceptor(auth: auth))
        self.api = api
        // نواة الرفع فوق الجلسة الخلفية المشتركة؛ تُستأنف السجلات غير المكتملة عند كل إطلاق.
        self.uploads = UploadQueueModel(engine: try! UploadServices.shared.makeEngine(api: api), settings: settings)
        Task { await self.restore() }
    }

    func restore() async {
        phase = await auth.session.map(Phase.signedIn) ?? .signedOut
        if case .signedIn = phase { uploads.start() }
        watchAuth()
    }

    /// إبطال عن بُعد (SEC-01): رُفض رمز التحديث ← تتوقف كل مهام الرفع الخلفية وتُمحى رموز الرفع وحالته، وتُعرض شاشة «أُبطلت الجلسة».
    private func watchAuth() {
        authWatcher?.cancel()
        authWatcher = Task { [weak self] in
            guard let self else { return }
            for await event in await auth.events() {
                guard case .sessionRevoked(let at) = event else { continue }
                _ = await uploads.engine.wipeAll()
                await uploads.refresh()
                phase = .revoked(at: at)
            }
        }
    }

    /// المسح الطارئ (SEC-01): محلي فقط وبلا اتصال؛ يوقف النقل ويمحو الرموز والحالة والأجزاء والأصول المستوردة والمصغّرات وذاكرة الصور،
    /// ثم يعيد التطبيق إلى شاشة البداية. لا يُسجَّل شيء.
    func emergencyWipe() async {
        let services = UploadServices.shared
        let engine = uploads.engine
        let auth = self.auth
        let steps: [WipeStep] = [
            // قرار المنسّق: إبطال كل الجلسات على الخادم بأفضل جهد (≤3 ث) قبل المحو؛ لا ينتظره المحو ولا يفشل بسببه.
            WipeStep(name: "revoke_remote") { await auth.revokeEverywhereBestEffort(timeout: 3) ? 1 : 0 },
            WipeStep(name: "uploads") { await engine.wipeAll() },
            WipeStep(name: "session") { await auth.forgetLocally(); return 1 },
            WipeStep(name: "upload_tokens") { try KeychainUploadSecretStore().removeAll(); return 1 },
            LocalDataWiper.directoryStep(name: "upload_state", url: services.stateDirectory),
            LocalDataWiper.directoryStep(name: "chunks", url: services.chunksDirectory),
            LocalDataWiper.directoryStep(name: "imported_originals", url: services.uploadsDirectory),
            LocalDataWiper.directoryStep(name: "caches", url: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]),
            LocalDataWiper.directoryStep(name: "temporary", url: FileManager.default.temporaryDirectory),
            WipeStep(name: "url_cache") { URLCache.shared.removeAllCachedResponses(); return 1 },
            LocalDataWiper.keyValueStep(name: "defaults", keys: ["deleteLocalAfterReceipt"], keep: ["hasLaunchedBefore"]) { key in
                UserDefaults.standard.removeObject(forKey: key); return true
            },
        ]
        let report = await EmergencyWipe(steps: steps).run()
        settings.reload()
        await uploads.refresh()
        phase = .wiped(report)
    }

    func acknowledgeAndSignIn() { phase = .signedOut }

    func login(email: String, password: String, totpCode: String) async throws {
        let session = try await auth.login(email: email, password: password, totpCode: totpCode.isEmpty ? nil : totpCode)
        phase = .signedIn(session)
        uploads.start()
    }

    func logout(allSessions: Bool) async {
        // الرموز تُمسح محليًا قبل الاتصال؛ فشل الشبكة لا يبقي الجلسة على الجهاز.
        try? await auth.logout(allSessions: allSessions)
        phase = .signedOut
    }
}

enum AppConfiguration {
    static var apiBaseURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "PHAPIBaseURL") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "https://api.example.invalid/v1"
    }
}

extension AuthError {
    /// مفتاح الرسالة في موارد التطبيق (ar/en)؛ لا نص حرفي في الكود.
    var messageKey: LocalizedStringKey {
        switch self {
        case .notSignedIn, .sessionExpired: return "auth.error.sessionExpired"
        case .totpRequired: return "auth.error.totpRequired"
        case .unauthorized: return "auth.error.unauthorized"
        case .rateLimited: return "auth.error.rateLimited"
        case .validation: return "auth.error.validation"
        case .server: return "auth.error.server"
        case .transport: return "auth.error.transport"
        }
    }
}
