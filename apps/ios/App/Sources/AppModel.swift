import AuthCore
import Foundation
import PostHistoryAPI
import SwiftUI

/// تركيب الطبقات: عميل API مولَّد بمعترض الهوية، وجلسة الهوية فوق Keychain.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, signedIn(StoredSession) }

    @Published private(set) var phase: Phase = .loading

    let auth: AuthSession
    /// إعداد العميل لكل المسارات المصادَق عليها (يضيف Bearer ويحدّث عند 401).
    let api: PostHistoryAPIAPIConfiguration

    init(store: any TokenStore = KeychainTokenStore(), baseURL: String = AppConfiguration.apiBaseURL) {
        // مسارات /auth/* بلا معترض كي لا يدخل التحديث في حلقة.
        let plain = PostHistoryAPIAPIConfiguration(basePath: baseURL)
        let auth = AuthSession(store: store, gateway: APIAuthGateway(configuration: plain))
        self.auth = auth
        self.api = PostHistoryAPIAPIConfiguration(basePath: baseURL, interceptor: AuthInterceptor(auth: auth))
        Task { await self.restore() }
    }

    func restore() async {
        phase = await auth.session.map(Phase.signedIn) ?? .signedOut
    }

    func login(email: String, password: String, totpCode: String) async throws {
        let session = try await auth.login(email: email, password: password, totpCode: totpCode.isEmpty ? nil : totpCode)
        phase = .signedIn(session)
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
