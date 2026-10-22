import Foundation
import Crypto
import UploadCore

/// رمز بوابة ingest عبر App Attest (SEC-07، ADR 0011):
/// 1. مرة لكل تثبيت: مفتاح في Secure Enclave، ثم شهادة Apple على `SHA-256(challenge)`، ثم `POST /device-attestations`.
/// 2. لكل رمز: تحدٍّ جديد، وتأكيد محلي على `SHA-256(challenge ‖ upload_session_id)`، ثم `POST /uploads/{id}/ingest-token`.
/// الرمز في الذاكرة حتى قبل انتهائه بهامش؛ معرّف المفتاح في Keychain؛ لا شيء من ذلك يُسجَّل.
public actor AppAttestIngestTokenProvider: IngestTokenProvider {
    private let backend: any AppAttestBackend
    private let api: any AttestationAPI
    private let keys: any AttestationKeyStore
    private let now: @Sendable () -> Date
    private let refreshMargin: TimeInterval

    private var cache: [UUID: IngestTokenValue] = [:]
    private var inflight: [UUID: Task<String, any Error>] = [:]

    /// محاولات التحدي المنتهي أو التأكيد المكرر قبل اعتباره عطلًا مؤقتًا.
    static let maxChallengeAttempts = 3

    public init(backend: any AppAttestBackend, api: any AttestationAPI, keys: any AttestationKeyStore,
                now: @escaping @Sendable () -> Date = { Date() }, refreshMargin: TimeInterval = 60) {
        self.backend = backend
        self.api = api
        self.keys = keys
        self.now = now
        self.refreshMargin = refreshMargin
    }

    public func ingestToken(uploadSessionId id: UUID, forceRefresh: Bool) async throws -> String {
        if forceRefresh {
            cache[id] = nil
        } else if let cached = cache[id], cached.expiresAt.timeIntervalSince(now()) > refreshMargin {
            return cached.token
        }
        if let running = inflight[id] { return try await running.value }
        let task = Task { try await self.fetch(id) }
        inflight[id] = task
        defer { inflight[id] = nil }
        return try await task.value
    }

    public func forget(uploadSessionId id: UUID) async { cache[id] = nil }

    /// المسح الطارئ: يُنسى كل رمز ومعرّف المفتاح (المفتاح نفسه في Secure Enclave لا يُستعاد بلا معرّفه).
    public func wipe() async {
        cache.removeAll()
        try? keys.removeKeyId()
    }

    private func fetch(_ id: UUID) async throws -> String {
        guard backend.isSupported else { throw IngestTokenError.unsupported }
        var reRegistered = false
        var attempts = 0
        while true {
            attempts += 1
            do {
                let keyId = try await ensureKey()
                let challenge = try await api.challenge()
                let clientData = challenge.bytes + Data(id.uuidString.lowercased().utf8)
                let assertion = try await backend.generateAssertion(keyId, clientDataHash: Self.sha256(clientData))
                let token = try await api.ingestToken(uploadSessionId: id, keyId: keyId, assertion: assertion, challengeId: challenge.id)
                cache[id] = token
                return token.token
            } catch let e where Self.needsNewKey(e) && !reRegistered {
                // مفتاح لا يعرفه الخادم أو أبطله، أو أبطلته Apple: مفتاح جديد وتسجيل جديد مرة واحدة.
                try? keys.removeKeyId()
                reRegistered = true
            } catch let e as AttestationAPIError where (e == .replay || e == .challengeExpired) && attempts < Self.maxChallengeAttempts {
                continue
            } catch {
                throw Self.classify(error)
            }
        }
    }

    private func ensureKey() async throws -> String {
        if let existing = try? keys.keyId() { return existing }
        let keyId = try await backend.generateKey()
        let challenge = try await api.challenge()
        let attestation = try await backend.attestKey(keyId, clientDataHash: Self.sha256(challenge.bytes))
        try await api.registerKey(keyId: keyId, attestation: attestation, challengeId: challenge.id)
        try keys.setKeyId(keyId)
        return keyId
    }

    static func needsNewKey(_ error: any Error) -> Bool {
        switch error {
        case AppAttestBackendError.invalidKey, AttestationAPIError.attestationFailed, AttestationAPIError.keyConflict: return true
        default: return false
        }
    }

    static func classify(_ error: any Error) -> IngestTokenError {
        switch error {
        case let e as IngestTokenError: return e
        case AppAttestBackendError.unsupported: return .unsupported
        case AppAttestBackendError.invalidKey, AttestationAPIError.attestationFailed, AttestationAPIError.keyConflict,
             AttestationAPIError.notFound, AttestationAPIError.status:
            return .attestationRejected
        default:
            // Apple أو الخادم غير متاحين، أو انقطاع، أو تحدٍّ منتهٍ مرارًا: يُعاد لاحقًا.
            return .temporarilyUnavailable
        }
    }

    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
}
