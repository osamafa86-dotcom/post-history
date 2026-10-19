import Foundation
import PostHistoryAPI

/// حالة الهوية على الجهاز: دخول، رمز وصول صالح (مع تحديث تلقائي بتدوير رمز التحديث)، وإبطال.
/// التحديث أحادي المسار: الطلبات المتزامنة تنتظر تحديثًا واحدًا، لأن رمز التحديث يُبطل عند أول استخدام.
public actor AuthSession {
    public typealias Clock = @Sendable () -> Date

    private let store: any TokenStore
    private let gateway: any AuthGateway
    private let now: Clock
    /// يُحدَّث الرمز قبل انتهائه بهذه المهلة كي لا يصل الخادم رمزٌ منتهٍ في الطريق.
    private let refreshLeeway: TimeInterval
    private var current: StoredSession?
    private var refreshInFlight: Task<StoredSession, Error>?

    public init(store: any TokenStore, gateway: any AuthGateway, refreshLeeway: TimeInterval = 60, now: @escaping Clock = { Date() }) {
        self.store = store
        self.gateway = gateway
        self.refreshLeeway = refreshLeeway
        self.now = now
        self.current = try? store.load()
    }

    public var isSignedIn: Bool { current != nil }
    public var session: StoredSession? { current }

    public func login(email: String, password: String, totpCode: String?) async throws -> StoredSession {
        do {
            let s = StoredSession(try await gateway.login(LoginRequest(email: email, password: password, totpCode: totpCode)))
            try store.save(s)
            current = s
            return s
        } catch {
            throw APIErrorMapper.map(error)
        }
    }

    /// رمز وصول صالح الآن؛ يحدّثه عند الحاجة. `force` يتجاوز فحص الانتهاء (بعد `401` من الخادم).
    public func validAccessToken(force: Bool = false) async throws -> String {
        guard let s = current else { throw AuthError.notSignedIn }
        if !force, s.expiresAt.timeIntervalSince(now()) > refreshLeeway { return s.accessToken }
        return try await refresh(ifStillUsing: s.accessToken).accessToken
    }

    /// يحدّث الجلسة مرة واحدة مهما تعدد المنتظرون. إن كان الرمز الحالي أحدث من `staleAccessToken` فقد حُدِّث بالفعل.
    @discardableResult
    public func refresh(ifStillUsing staleAccessToken: String? = nil) async throws -> StoredSession {
        if let staleAccessToken, let s = current, s.accessToken != staleAccessToken { return s }
        if let task = refreshInFlight { return try await task.value }
        guard let s = current else { throw AuthError.notSignedIn }
        let task = Task<StoredSession, Error> { [gateway, store] in
            do {
                let fresh = StoredSession(try await gateway.refresh(refreshToken: s.refreshToken))
                try store.save(fresh)
                return fresh
            } catch {
                let mapped = APIErrorMapper.map(error)
                if mapped == .unauthorized { try? store.clear(); throw AuthError.sessionExpired }
                throw mapped
            }
        }
        refreshInFlight = task
        defer { refreshInFlight = nil }
        do {
            let fresh = try await task.value
            current = fresh
            return fresh
        } catch AuthError.sessionExpired {
            current = nil
            throw AuthError.sessionExpired
        }
    }

    /// ينهي الجلسة محليًا دائمًا ثم يبلغ الخادم؛ خطأ الشبكة لا يُبقي الرموز على الجهاز.
    public func logout(allSessions: Bool = false) async throws {
        let s = current
        current = nil
        refreshInFlight?.cancel()
        try? store.clear()
        guard let s else { return }
        do { try await gateway.logout(allSessions: allSessions, accessToken: s.accessToken) } catch { throw APIErrorMapper.map(error) }
    }
}
