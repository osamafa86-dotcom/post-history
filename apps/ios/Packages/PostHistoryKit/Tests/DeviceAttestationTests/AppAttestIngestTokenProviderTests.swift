import XCTest
import PostHistoryAPI
import Crypto
import UploadCore
@testable import DeviceAttestation

final class FakeBackend: AppAttestBackend, @unchecked Sendable {
    let lock = NSLock()
    var supported = true
    var generated = 0
    var attestHashes: [Data] = []
    var assertionHashes: [Data] = []
    var assertionError: AppAttestBackendError?
    var attestError: AppAttestBackendError?
    var isSupported: Bool { lock.withLock { supported } }
    func generateKey() async throws -> String { lock.withLock { generated += 1; return "key-\(generated)" } }
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try lock.withLock { if let e = attestError { throw e }; attestHashes.append(clientDataHash); return Data("att-\(keyId)".utf8) }
    }
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try lock.withLock {
            if let e = assertionError { assertionError = nil; throw e }
            assertionHashes.append(clientDataHash); return Data("as-\(keyId)".utf8)
        }
    }
}

final class FakeAttestationAPI: AttestationAPI, @unchecked Sendable {
    let lock = NSLock()
    var challenges: [AttestationChallengeValue] = []
    var registered: [String] = []
    var tokenRequests: [(UUID, String)] = []
    /// أخطاء رمز ingest بالترتيب قبل النجاح.
    var tokenErrors: [AttestationAPIError] = []
    var registerError: AttestationAPIError?
    var knownKeys: Set<String> = []
    var issued = 0
    var tokenLifetime: TimeInterval = 900

    func challenge() async throws -> AttestationChallengeValue {
        lock.withLock {
            let c = AttestationChallengeValue(id: UUID(), bytes: Data((0..<32).map { _ in UInt8.random(in: 0...255) }), expiresAt: Date().addingTimeInterval(300))
            challenges.append(c); return c
        }
    }
    func registerKey(keyId: String, attestation: Data, challengeId: UUID) async throws {
        try lock.withLock { if let e = registerError { throw e }; registered.append(keyId); knownKeys.insert(keyId) }
    }
    func ingestToken(uploadSessionId: UUID, keyId: String, assertion: Data, challengeId: UUID) async throws -> IngestTokenValue {
        try lock.withLock {
            tokenRequests.append((uploadSessionId, keyId))
            if !tokenErrors.isEmpty { throw tokenErrors.removeFirst() }
            guard knownKeys.contains(keyId) else { throw AttestationAPIError.attestationFailed }
            issued += 1
            return IngestTokenValue(token: "jwt-\(issued)", expiresAt: Date().addingTimeInterval(tokenLifetime))
        }
    }
}

final class AppAttestIngestTokenProviderTests: XCTestCase {
    let session = UUID(uuidString: "5D6C7B8A-9F0E-4D1C-8B2A-3C4D5E6F7A8B")!

    func make(backend: FakeBackend = FakeBackend(), api: FakeAttestationAPI = FakeAttestationAPI(), keys: InMemoryAttestationKeyStore = InMemoryAttestationKeyStore())
        -> (AppAttestIngestTokenProvider, FakeBackend, FakeAttestationAPI, InMemoryAttestationKeyStore) {
        (AppAttestIngestTokenProvider(backend: backend, api: api, keys: keys), backend, api, keys)
    }

    func testFirstTokenRegistersTheKeyOnceAndSignsChallengeAndSession() async throws {
        let (p, backend, api, keys) = make()
        let token = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(token, "jwt-1")
        XCTAssertEqual(api.registered, ["key-1"])
        XCTAssertEqual(try keys.keyId(), "key-1")
        // تسجيل المفتاح: clientDataHash = SHA-256(challenge)
        XCTAssertEqual(backend.attestHashes, [Data(SHA256.hash(data: api.challenges[0].bytes))])
        // التأكيد: SHA-256(challenge ‖ معرّف الجلسة بحروف صغيرة) كما يبنيه الخادم
        let expected = Data(SHA256.hash(data: api.challenges[1].bytes + Data("5d6c7b8a-9f0e-4d1c-8b2a-3c4d5e6f7a8b".utf8)))
        XCTAssertEqual(backend.assertionHashes, [expected])
        XCTAssertEqual(api.tokenRequests.first?.0, session)
    }

    func testCachedTokenIsReusedAndASecondSessionDoesNotReRegister() async throws {
        let (p, backend, api, _) = make()
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        let again = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(again, "jwt-1")
        let other = try await p.ingestToken(uploadSessionId: UUID(), forceRefresh: false)
        XCTAssertEqual(other, "jwt-2")
        XCTAssertEqual(backend.generated, 1)
        XCTAssertEqual(api.registered.count, 1)
    }

    func testForceRefreshAndNearExpiryFetchANewToken() async throws {
        let api = FakeAttestationAPI()
        api.tokenLifetime = 30 // أقل من هامش التجديد (60 ث)
        let (p, _, _, _) = make(api: api)
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        let second = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(second, "jwt-2", "a token about to expire is not reused")
        api.tokenLifetime = 900
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        let forced = try await p.ingestToken(uploadSessionId: session, forceRefresh: true)
        XCTAssertEqual(forced, "jwt-4")
    }

    func testConcurrentRequestsForOneSessionShareOneFetch() async throws {
        let (p, _, api, _) = make()
        async let a = p.ingestToken(uploadSessionId: session, forceRefresh: false)
        async let b = p.ingestToken(uploadSessionId: session, forceRefresh: false)
        let (ta, tb) = try await (a, b)
        XCTAssertEqual(ta, tb)
        XCTAssertEqual(api.issued, 1)
    }

    func testUnknownKeyOnTheServerRegistersANewKeyOnce() async throws {
        // معرّف محفوظ لا يعرفه الخادم (قاعدة بيانات أُعيدت، أو مفتاح أُبطل): 403 attestation_failed ← مفتاح جديد.
        let keys = InMemoryAttestationKeyStore(keyId: "stale-key")
        let (p, backend, api, _) = make(keys: keys)
        let token = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(token, "jwt-1")
        XCTAssertEqual(backend.generated, 1)
        XCTAssertEqual(try keys.keyId(), "key-1")
        XCTAssertEqual(api.tokenRequests.map(\.1), ["stale-key", "key-1"])
    }

    func testRepeatedRejectionAfterReRegistrationIsFinal() async throws {
        let api = FakeAttestationAPI()
        api.tokenErrors = [.attestationFailed, .attestationFailed]
        let (p, _, _, _) = make(api: api)
        do { _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false); XCTFail("expected rejection") }
        catch { XCTAssertEqual(error as? IngestTokenError, .attestationRejected) }
    }

    func testInvalidKeyFromAppleRegeneratesTheKey() async throws {
        let backend = FakeBackend()
        backend.assertionError = .invalidKey
        let keys = InMemoryAttestationKeyStore()
        let api = FakeAttestationAPI()
        let (p, _, _, _) = make(backend: backend, api: api, keys: keys)
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(backend.generated, 2)
        XCTAssertEqual(try keys.keyId(), "key-2")
    }

    func testExpiredChallengeOrReplayIsRetriedWithAFreshChallenge() async throws {
        let api = FakeAttestationAPI()
        api.tokenErrors = [.challengeExpired, .replay]
        let (p, _, _, _) = make(api: api)
        let token = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(token, "jwt-1")
        XCTAssertEqual(api.tokenRequests.count, 3)
    }

    func testUnsupportedDeviceAndOutagesAreClassified() async throws {
        let backend = FakeBackend()
        backend.supported = false
        let (p, _, api, _) = make(backend: backend)
        do { _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false); XCTFail() }
        catch { XCTAssertEqual(error as? IngestTokenError, .unsupported) }
        XCTAssertTrue(api.challenges.isEmpty, "nothing is sent from a device without App Attest")

        let blocked = FakeBackend()
        blocked.attestError = .serverUnavailable // Apple محجوبة عند أول تسجيل
        let (p2, _, _, keys2) = make(backend: blocked)
        do { _ = try await p2.ingestToken(uploadSessionId: session, forceRefresh: false); XCTFail() }
        catch { XCTAssertEqual(error as? IngestTokenError, .temporarilyUnavailable) }
        XCTAssertNil(try keys2.keyId(), "an unregistered key is not kept")

        let api3 = FakeAttestationAPI()
        api3.tokenErrors = [.unavailable]
        let (p3, _, _, _) = make(api: api3)
        do { _ = try await p3.ingestToken(uploadSessionId: session, forceRefresh: false); XCTFail() }
        catch { XCTAssertEqual(error as? IngestTokenError, .temporarilyUnavailable) }
    }

    func testWipeForgetsTokensAndTheKeyId() async throws {
        let (p, _, api, keys) = make()
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        await p.wipe()
        XCTAssertNil(try keys.keyId())
        _ = try await p.ingestToken(uploadSessionId: session, forceRefresh: false)
        XCTAssertEqual(api.registered.count, 2, "after a wipe the next upload registers a fresh key")
    }

    func testServerErrorCodesMapToTheContract() {
        func body(_ code: String) -> Data { Data(#"{"code":"\#(code)","message":"m","request_id":"r"}"#.utf8) }
        struct E: Error {}
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(403, body("attestation_failed"), nil, E())), .attestationFailed)
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(409, body("attestation_key_conflict"), nil, E())), .keyConflict)
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(409, body("assertion_replay"), nil, E())), .replay)
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(410, body("challenge_expired"), nil, E())), .challengeExpired)
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(503, body("attestation_unavailable"), nil, E())), .unavailable)
        XCTAssertEqual(AttestationAPIError.map(ErrorResponse.error(403, body("forbidden"), nil, E())), .status(403))
        XCTAssertEqual(Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")?.count, 32)
    }
}
