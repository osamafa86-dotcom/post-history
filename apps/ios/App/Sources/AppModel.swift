import AuthCore
import Foundation
import PostHistoryAPI
import SwiftUI
import UploadCore

/// تركيب الطبقات: عميل API مولَّد بمعترض الهوية، وجلسة الهوية فوق Keychain.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn(StoredSession) }

    @Published private(set) var phase: Phase = .loading

    let auth: AuthSession
    /// إعداد العميل لكل المسارات المصادَق عليها (يضيف Bearer ويحدّث عند 401).
    let api: PostHistoryAPIAPIConfiguration
    let settings = AppSettings()
    let uploads: UploadQueueModel

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
    }

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
