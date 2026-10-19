import Foundation
import PostHistoryAPI
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// مسارات `/uploads` من العقد التي تحتاجها النواة؛ مفصولة لتُختبر بمحاكاة.
public protocol UploadAPI: Sendable {
    func createSession(idempotencyKey: String, _ body: UploadSessionCreate) async throws -> UploadSessionCreated
    func session(id: UUID) async throws -> UploadSession
    /// `202` عند القبول. في مسار tusd يعيد الخادم `409 upload_state_conflict` ما لم يكن الخطّاف قد أكمل الجلسة؛ يبلّغه التنفيذ كـ `UploadAPIError.conflict`.
    func complete(idempotencyKey: String, id: UUID, reportedSha256: String?) async throws
}

public enum UploadAPIError: Error, Equatable, Sendable {
    case conflict
    case notFound
    case unauthorized
    case status(Int)
    case transport

    public static func map(_ error: any Error) -> UploadAPIError {
        guard case let ErrorResponse.error(status, _, _, _) = error else { return .transport }
        switch status {
        case 409: return .conflict
        case 404: return .notFound
        case 401, 403: return .unauthorized
        case ..<1: return .transport
        default: return .status(status)
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .transport: return true
        case .status(let s): return s >= 500 || s == 429
        case .conflict, .notFound, .unauthorized: return false
        }
    }
}

public struct GeneratedUploadAPI: UploadAPI {
    private let configuration: PostHistoryAPIAPIConfiguration
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }

    public func createSession(idempotencyKey: String, _ body: UploadSessionCreate) async throws -> UploadSessionCreated {
        do { return try await UploadsAPI.createUploadSession(idempotencyKey: idempotencyKey, uploadSessionCreate: body, apiConfiguration: configuration) }
        catch { throw UploadAPIError.map(error) }
    }

    public func session(id: UUID) async throws -> UploadSession {
        do { return try await UploadsAPI.getUploadSession(id: id, apiConfiguration: configuration) } catch { throw UploadAPIError.map(error) }
    }

    public func complete(idempotencyKey: String, id: UUID, reportedSha256: String?) async throws {
        do { try await UploadsAPI.completeUpload(idempotencyKey: idempotencyKey, id: id, uploadComplete: UploadComplete(reportedSha256: reportedSha256), apiConfiguration: configuration) }
        catch { throw UploadAPIError.map(error) }
    }
}
