import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PostHistoryAPI

/// مسارات الهوية الثلاثة من العقد. يفصل `AuthSession` عن النقل كي تُختبر دورة الرموز بمحاكاة.
public protocol AuthGateway: Sendable {
    func login(_ request: LoginRequest) async throws -> Session
    func refresh(refreshToken: String) async throws -> Session
    func logout(allSessions: Bool, accessToken: String) async throws
}

/// التنفيذ عبر العميل المولَّد. مسارات `/auth/*` لا تحمل `Idempotency-Key` ولا تمر بمعترض التحديث.
public struct APIAuthGateway: AuthGateway {
    private let configuration: PostHistoryAPIAPIConfiguration

    /// `configuration` يجب أن تكون بلا معترض هوية (وإلا حلقة تحديث داخل التحديث).
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }

    public func login(_ request: LoginRequest) async throws -> Session {
        try await AuthAPI.login(loginRequest: request, apiConfiguration: configuration)
    }

    public func refresh(refreshToken: String) async throws -> Session {
        try await AuthAPI.refreshSession(refreshSessionRequest: RefreshSessionRequest(refreshToken: refreshToken), apiConfiguration: configuration)
    }

    public func logout(allSessions: Bool, accessToken: String) async throws {
        let builder = AuthAPI.logoutWithRequestBuilder(logoutRequest: LogoutRequest(allSessions: allSessions), apiConfiguration: configuration)
        _ = builder.addHeader(name: "Authorization", value: "Bearer \(accessToken)")
        _ = try await builder.execute()
    }
}
