import Foundation
import PostHistoryAPI

/// أحداث الهوية التي تهم الواجهة: إبطال الجلسة عن بُعد يُكتشف حين يرفض الخادم رمز التحديث (العقد: الإبطال يُفحص عند كل طلب).
public enum AuthEvent: Equatable, Sendable {
    /// رُفض رمز التحديث: الجلسة أُبطلت (من الإدارة أو من جهاز آخر) أو انتهت. مُسحت الرموز محليًا.
    case sessionRevoked(at: Date)
    case signedOut
}

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
    private var subscribers: [UUID: AsyncStream<AuthEvent>.Continuation] = [:]

    public init(store: any TokenStore, gateway: any AuthGateway, refreshLeeway: TimeInterval = 60, now: @escaping Clock = { Date() }) {
        self.store = store
        self.gateway = gateway
        self.refreshLeeway = refreshLeeway
        self.now = now
        self.current = try? store.load()
    }

    public var isSignedIn: Bool { current != nil }
    public var session: StoredSession? { current }

    public func events() -> AsyncStream<AuthEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<AuthEvent>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeSubscriber(id) } }
        return stream
    }

    private func removeSubscriber(_ id: UUID) { subscribers[id] = nil }
    private func emit(_ event: AuthEvent) { subscribers.values.forEach { $0.yield(event) } }

    /// قبل المسح الطارئ (قرار المنسّق): إبطال كل الجلسات على الخادم بأفضل جهد ضمن مهلة قصيرة؛ لا ينتظره المحو ولا يفشل بسببه.
    /// يعيد `true` إن قبل الخادم الطلب ضمن المهلة. لا يُسجَّل شيء.
    public func revokeEverywhereBestEffort(timeout: TimeInterval = 3) async -> Bool {
        guard let s = current else { return false }
        let gateway = self.gateway
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask { (try? await gateway.logout(allSessions: true, accessToken: s.accessToken)) != nil }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    /// ينسى الجلسة محليًا دون أي اتصال (المسح الطارئ): يمسح المخزن ويلغي تحديثًا جاريًا. لا يُسجَّل شيء.
    public func forgetLocally() {
        refreshInFlight?.cancel()
        refreshInFlight = nil
        current = nil
        try? store.clear()
        emit(.signedOut)
    }

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
            emit(.sessionRevoked(at: now()))
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
