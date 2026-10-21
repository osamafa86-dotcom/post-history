import Foundation
import PostHistoryAPI
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// مسارات شهادة الجهاز من العقد (SEC-07): التحدي، وتسجيل المفتاح، ورمز ingest للجلسة.
public protocol AttestationAPI: Sendable {
    func challenge() async throws -> AttestationChallengeValue
    func registerKey(keyId: String, attestation: Data, challengeId: UUID) async throws
    func ingestToken(uploadSessionId: UUID, keyId: String, assertion: Data, challengeId: UUID) async throws -> IngestTokenValue
}

public struct AttestationChallengeValue: Sendable, Equatable {
    public var id: UUID
    /// البايتات الخام الـ32 (بعد فك base64url).
    public var bytes: Data
    public var expiresAt: Date
    public init(id: UUID, bytes: Data, expiresAt: Date) { self.id = id; self.bytes = bytes; self.expiresAt = expiresAt }
}

public struct IngestTokenValue: Sendable, Equatable {
    public var token: String
    public var expiresAt: Date
    public init(token: String, expiresAt: Date) { self.token = token; self.expiresAt = expiresAt }
}

public enum AttestationAPIError: Error, Equatable, Sendable {
    /// `403 attestation_failed`: الشهادة أو التأكيد مرفوضان (ومنه مفتاح لا يعرفه الخادم).
    case attestationFailed
    /// `409 attestation_key_conflict`: المفتاح مسجَّل لحساب آخر أو مبطَل.
    case keyConflict
    /// `409 assertion_replay`: عدّاد التأكيد لم يتزايد.
    case replay
    /// `410 challenge_expired`.
    case challengeExpired
    /// `503 attestation_unavailable` أو `429` أو `5xx`.
    case unavailable
    /// `401`: جلسة الدخول انتهت (يتولاها معترض AuthCore).
    case unauthorized
    /// `404`: الجلسة ليست لهذا المستخدم أو لم تعد حية، أو الشهادة غير مفعّلة على الخادم.
    case notFound
    case status(Int)
    case transport

    public static func map(_ error: any Error) -> AttestationAPIError {
        guard case let ErrorResponse.error(status, data, _, _) = error else { return .transport }
        let code = data.flatMap { try? JSONDecoder().decode(ModelError.self, from: $0) }?.code.rawValue
        switch (status, code) {
        case (403, "attestation_failed"): return .attestationFailed
        case (409, "attestation_key_conflict"): return .keyConflict
        case (409, "assertion_replay"): return .replay
        case (410, _): return .challengeExpired
        case (401, _): return .unauthorized
        case (404, _): return .notFound
        case (429, _), (500..., _): return .unavailable
        case (..<1, _): return .transport
        default: return .status(status)
        }
    }
}

public struct GeneratedAttestationAPI: AttestationAPI {
    private let configuration: PostHistoryAPIAPIConfiguration
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }

    public func challenge() async throws -> AttestationChallengeValue {
        let c: AttestationChallenge
        do { c = try await UploadsAPI.createAttestationChallenge(idempotencyKey: UUID().uuidString, apiConfiguration: configuration) }
        catch { throw AttestationAPIError.map(error) }
        guard let bytes = Base64URL.decode(c.challenge) else { throw AttestationAPIError.status(200) }
        return AttestationChallengeValue(id: c.challengeId, bytes: bytes, expiresAt: c.expiresAt)
    }

    public func registerKey(keyId: String, attestation: Data, challengeId: UUID) async throws {
        let body = AttestationKeyRegistration(platform: .ios, keyId: keyId, attestation: attestation.base64EncodedString(), challengeId: challengeId)
        do { _ = try await UploadsAPI.registerAttestationKey(idempotencyKey: UUID().uuidString, attestationKeyRegistration: body, apiConfiguration: configuration) }
        catch { throw AttestationAPIError.map(error) }
    }

    public func ingestToken(uploadSessionId: UUID, keyId: String, assertion: Data, challengeId: UUID) async throws -> IngestTokenValue {
        let body = IngestTokenRequest.typeIngestTokenRequestIos(
            IngestTokenRequestIos(platform: .ios, keyId: keyId, assertion: assertion.base64EncodedString(), challengeId: challengeId))
        do {
            let t = try await UploadsAPI.createIngestToken(idempotencyKey: UUID().uuidString, id: uploadSessionId, ingestTokenRequest: body, apiConfiguration: configuration)
            return IngestTokenValue(token: t.token, expiresAt: t.expiresAt)
        } catch { throw AttestationAPIError.map(error) }
    }
}

enum Base64URL {
    static func decode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}
