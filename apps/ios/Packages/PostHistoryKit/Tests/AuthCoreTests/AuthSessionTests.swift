import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PostHistoryAPI
@testable import AuthCore

/// بوابة محاكاة: تعدّ الاستدعاءات وتصدر رموزًا متسلسلة، وتستطيع رفض التحديث.
final class FakeGateway: AuthGateway, @unchecked Sendable {
    let lock = NSLock()
    var loginCalls = 0, refreshCalls = 0, logoutCalls: [(Bool, String)] = []
    var refreshDelay: UInt64 = 0
    var logoutDelay: UInt64 = 0
    var rejectRefresh = false
    var rejectLoginStatus: Int?
    var rejectLoginCode: ModelError.Code?
    var seenRefreshTokens: [String] = []

    private func session(_ n: Int) -> Session {
        Session(accessToken: "access-\(n)", refreshToken: "refresh-\(n)", expiresAt: Date().addingTimeInterval(900), userId: UUID(), roles: [Role(name: .reporter, scopes: [])])
    }
    private func errorResponse(_ status: Int, code: ModelError.Code?) -> ErrorResponse {
        let body = code.map { try! JSONEncoder().encode(ModelError(code: $0, message: "m", requestId: "r")) }
        let http = HTTPURLResponse(url: URL(string: "https://api.example.invalid/v1/x")!, statusCode: status, httpVersion: nil, headerFields: status == 429 ? ["Retry-After": "7"] : nil)
        return ErrorResponse.error(status, body, http, DecodableRequestBuilderError.unsuccessfulHTTPStatusCode)
    }
    func login(_ request: LoginRequest) async throws -> Session {
        lock.withLock { loginCalls += 1 }
        if let status = rejectLoginStatus { throw errorResponse(status, code: rejectLoginCode) }
        return session(1)
    }
    func refresh(refreshToken: String) async throws -> Session {
        let n = lock.withLock { refreshCalls += 1; seenRefreshTokens.append(refreshToken); return refreshCalls }
        if refreshDelay > 0 { try await Task.sleep(nanoseconds: refreshDelay) }
        if rejectRefresh { throw errorResponse(401, code: .unauthorized) }
        return session(n + 1)
    }
    func logout(allSessions: Bool, accessToken: String) async throws {
        lock.withLock { logoutCalls.append((allSessions, accessToken)) }
        if logoutDelay > 0 { try await Task.sleep(nanoseconds: logoutDelay) }
    }
}

final class AuthSessionTests: XCTestCase {
    private func stored(expiresIn: TimeInterval, token: String = "access-1") -> StoredSession {
        StoredSession(accessToken: token, refreshToken: "refresh-1", expiresAt: Date().addingTimeInterval(expiresIn), userId: UUID(), roles: [])
    }

    func testLoginStoresSessionInStore() async throws {
        let store = InMemoryTokenStore(); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw)
        let s = try await auth.login(email: "r@example.invalid", password: "password1", totpCode: "123456")
        XCTAssertEqual(s.accessToken, "access-1")
        XCTAssertEqual(try store.load(), s)
        let signedIn = await auth.isSignedIn
        XCTAssertTrue(signedIn)
    }

    func testLoginMapsTotpRequiredAndRateLimit() async {
        let gw = FakeGateway(); gw.rejectLoginStatus = 401; gw.rejectLoginCode = .totpRequired
        let auth = AuthSession(store: InMemoryTokenStore(), gateway: gw)
        do { _ = try await auth.login(email: "r@example.invalid", password: "password1", totpCode: nil); XCTFail() }
        catch { XCTAssertEqual(error as? AuthError, .totpRequired) }
        gw.rejectLoginStatus = 429; gw.rejectLoginCode = .rateLimited
        do { _ = try await auth.login(email: "r@example.invalid", password: "password1", totpCode: nil); XCTFail() }
        catch { XCTAssertEqual(error as? AuthError, .rateLimited(retryAfterSeconds: 7)) }
    }

    func testRestoresSessionFromStoreAndReturnsTokenWithoutRefresh() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 600)); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw)
        let token = try await auth.validAccessToken()
        XCTAssertEqual(token, "access-1")
        XCTAssertEqual(gw.refreshCalls, 0)
    }

    func testRefreshesWhenWithinLeewayAndRotatesRefreshToken() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 30)); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw, refreshLeeway: 60)
        let token = try await auth.validAccessToken()
        XCTAssertEqual(token, "access-2")
        XCTAssertEqual(gw.seenRefreshTokens, ["refresh-1"])
        XCTAssertEqual(try store.load()?.refreshToken, "refresh-2")
    }

    func testConcurrentCallersShareOneRefresh() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 0)); let gw = FakeGateway(); gw.refreshDelay = 50_000_000
        let auth = AuthSession(store: store, gateway: gw)
        let tokens = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<8 { group.addTask { try await auth.validAccessToken() } }
            return try await group.reduce(into: [String]()) { $0.append($1) }
        }
        XCTAssertEqual(Set(tokens), ["access-2"])
        XCTAssertEqual(gw.refreshCalls, 1)
    }

    func testForcedRefreshAfter401SkipsIfAlreadyRefreshed() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 600)); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw)
        _ = try await auth.refresh(ifStillUsing: "access-1")
        _ = try await auth.refresh(ifStillUsing: "access-1") // طلب آخر فشل بالرمز القديم بعد أن حُدِّث
        XCTAssertEqual(gw.refreshCalls, 1)
        let token = try await auth.validAccessToken(force: true)
        XCTAssertEqual(token, "access-3")
    }

    func testRejectedRefreshClearsStoreAndSignsOut() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 0)); let gw = FakeGateway(); gw.rejectRefresh = true
        let auth = AuthSession(store: store, gateway: gw)
        do { _ = try await auth.validAccessToken(); XCTFail() } catch { XCTAssertEqual(error as? AuthError, .sessionExpired) }
        XCTAssertNil(try store.load())
        let signedIn = await auth.isSignedIn
        XCTAssertFalse(signedIn)
        do { _ = try await auth.validAccessToken(); XCTFail() } catch { XCTAssertEqual(error as? AuthError, .notSignedIn) }
    }

    func testLogoutClearsLocallyAndCallsServerWithAllSessions() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 600)); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw)
        try await auth.logout(allSessions: true)
        XCTAssertNil(try store.load())
        XCTAssertEqual(gw.logoutCalls.count, 1)
        XCTAssertEqual(gw.logoutCalls.first?.0, true)
        XCTAssertEqual(gw.logoutCalls.first?.1, "access-1")
    }

    func testErrorMapperHandlesTransportAndServerCodes() {
        // اسم النوع يختلف بين Darwin (NSError) وLinux (URLError)؛ المهم التصنيف لا النص.
        guard case .transport = APIErrorMapper.map(URLError(.notConnectedToInternet)) else { return XCTFail("URLError must map to transport") }
        let body = try! JSONEncoder().encode(ModelError(code: .idempotencyKeyReused, message: "m", requestId: "r"))
        XCTAssertEqual(APIErrorMapper.map(ErrorResponse.error(422, body, nil, URLError(.badServerResponse))), .validation)
        XCTAssertEqual(APIErrorMapper.map(ErrorResponse.error(409, body, nil, URLError(.badServerResponse))), .server(code: "idempotency_key_reused", status: 409))
    }
}

final class AuthRevocationTests: XCTestCase {
    private func stored(expiresIn: TimeInterval) -> StoredSession {
        StoredSession(accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date().addingTimeInterval(expiresIn), userId: UUID(), roles: [])
    }

    func testRevokedSessionEmitsEventAndClearsStore() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 0)); let gw = FakeGateway(); gw.rejectRefresh = true
        let auth = AuthSession(store: store, gateway: gw)
        let stream = await auth.events()
        let collector = Task { for await e in stream { return e }; return AuthEvent.signedOut }
        let detectedAt = Date()
        do { _ = try await auth.validAccessToken(); XCTFail() } catch { XCTAssertEqual(error as? AuthError, .sessionExpired) }
        let event = await collector.value
        guard case .sessionRevoked(let at) = event else { return XCTFail("expected sessionRevoked, got \(event)") }
        XCTAssertLessThan(abs(at.timeIntervalSince(detectedAt)), 2, "client reacts within the same request")
        XCTAssertNil(try store.load())
        XCTAssertEqual(gw.refreshCalls, 1)
    }

    func testBestEffortRevokeReturnsWithinTimeoutWhenServerHangs() async throws {
        let gw = FakeGateway(); gw.logoutDelay = 10_000_000_000
        let auth = AuthSession(store: InMemoryTokenStore(stored(expiresIn: 600)), gateway: gw)
        let started = Date()
        let sent = await auth.revokeEverywhereBestEffort(timeout: 0.2)
        XCTAssertFalse(sent)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "the wipe never waits for the network")
        XCTAssertEqual(gw.logoutCalls.first?.0, true, "all sessions, so upload tokens are revoked too")
        let signedIn = await auth.isSignedIn
        XCTAssertTrue(signedIn, "best-effort revoke does not clear local state; forgetLocally does")
    }

    func testBestEffortRevokeReportsSuccessWhenServerAnswers() async throws {
        let gw = FakeGateway()
        let auth = AuthSession(store: InMemoryTokenStore(stored(expiresIn: 600)), gateway: gw)
        let sent = await auth.revokeEverywhereBestEffort(timeout: 3)
        XCTAssertTrue(sent)
        let signedOutAuth = AuthSession(store: InMemoryTokenStore(), gateway: gw)
        let none = await signedOutAuth.revokeEverywhereBestEffort(timeout: 3)
        XCTAssertFalse(none, "nothing to revoke without a session")
    }

    func testForgetLocallyClearsWithoutNetworkAndEmitsSignedOut() async throws {
        let store = InMemoryTokenStore(stored(expiresIn: 600)); let gw = FakeGateway()
        let auth = AuthSession(store: store, gateway: gw)
        let stream = await auth.events()
        let collector = Task { for await e in stream { return e }; return AuthEvent.sessionRevoked(at: Date()) }
        await auth.forgetLocally()
        let event = await collector.value
        XCTAssertEqual(event, .signedOut)
        XCTAssertNil(try store.load())
        XCTAssertEqual(gw.logoutCalls.count, 0, "no network call during an emergency wipe")
        let signedIn = await auth.isSignedIn
        XCTAssertFalse(signedIn)
    }
}
