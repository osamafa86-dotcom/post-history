import Foundation
#if canImport(DeviceCheck)
import DeviceCheck
#endif

/// خدمة App Attest كما يحتاجها التطبيق؛ مفصولة كي يُختبر التدفق على Linux بمحاكاة.
public protocol AppAttestBackend: Sendable {
    /// `false` على الأجهزة القديمة والمحاكي: لا رمز ingest ممكن.
    var isSupported: Bool { get }
    /// مفتاح جديد في Secure Enclave؛ يعيد معرّفه (base64). المعرّف معرّف تثبيت: لا يُسجَّل ولا يُعرض.
    func generateKey() async throws -> String
    /// شهادة Apple للمفتاح على `clientDataHash` (يحتاج الشبكة إلى Apple مرة لكل تثبيت).
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    /// تأكيد محلي على `clientDataHash`؛ لا يحتاج Apple.
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}

public enum AppAttestBackendError: Error, Equatable, Sendable {
    /// المفتاح غير صالح (حُذف التطبيق وأُعيد، أو تغيّر الجهاز): يُولَّد مفتاح جديد.
    case invalidKey
    /// خوادم Apple غير متاحة أو محجوبة: يُعاد لاحقًا.
    case serverUnavailable
    case unsupported
    case failed
}

#if canImport(DeviceCheck) && os(iOS)
/// التنفيذ على الجهاز عبر `DCAppAttestService`.
public struct DeviceCheckAppAttestBackend: AppAttestBackend {
    public init() {}

    public var isSupported: Bool { DCAppAttestService.shared.isSupported }

    public func generateKey() async throws -> String {
        do { return try await DCAppAttestService.shared.generateKey() } catch { throw Self.map(error) }
    }

    public func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        do { return try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash) } catch { throw Self.map(error) }
    }

    public func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        do { return try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash) } catch { throw Self.map(error) }
    }

    static func map(_ error: any Error) -> AppAttestBackendError {
        guard let dc = error as? DCError else { return .failed }
        switch dc.code {
        case .invalidKey, .invalidInput: return .invalidKey
        case .serverUnavailable: return .serverUnavailable
        case .featureUnsupported: return .unsupported
        default: return .failed
        }
    }
}
#endif

/// خارج iOS (أدوات القياس على Linux، macOS): لا App Attest، فلا رمز ingest.
public struct UnsupportedAppAttestBackend: AppAttestBackend {
    public init() {}
    public var isSupported: Bool { false }
    public func generateKey() async throws -> String { throw AppAttestBackendError.unsupported }
    public func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { throw AppAttestBackendError.unsupported }
    public func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { throw AppAttestBackendError.unsupported }
}
