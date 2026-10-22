import Foundation
import PostHistoryAPI
@testable import UploadCore

/// خادم tus محاكى: يحتفظ بما وصل فعلًا، ويرد على كل PATCH حسب نص مكتوب مسبقًا (نجاح، قبول جزئي ثم انقطاع، خطأ، تعليق كأن التطبيق قُتل).
final class FakeTransport: TusTransport, @unchecked Sendable {
    enum Behavior { case ok, partial(Int64), fail(TusError), hang }
    /// قاعدة الإنشاء الواحد على الخادم: `pre-create` يحجز الجلسة، وأي إنشاء ثانٍ بالرمز نفسه يُرفض بـ 403.
    enum CreateBehavior { case ok, lostResponse }

    let lock = NSLock()
    var script: [Behavior]
    var createScript: [CreateBehavior] = []
    var created = false
    var serverBytes = Data()
    var serverOffset: Int64 = 0
    var patches: [(offset: Int64, length: Int64)] = []
    var creates: [TusCreateRequest] = []
    var headCalls = 0
    var activeKeys: Set<TusTaskKey> = []
    var pendingKeys: [TusTaskKey] = []
    var headError: TusError?
    /// بوابة ingest محاكاة: إن ضُبط، كل طلب برمز غير هذا يُرفض بـ 401 قبل أن يصل إلى tusd.
    var validIngestToken: String?
    var ingestTokensSeen: [String?] = []
    /// «انتهاء» الرمز: بعد هذا العدد من الأجزاء المقبولة يصير الرمز الصالح هو القيمة الثانية.
    var rotateIngestTokenAfterPatches: (count: Int, to: String)?
    weak var delegate: TusTransportDelegate?
    var uploadURL = URL(string: "https://ingest.example.invalid/files/abc123")!

    init(script: [Behavior] = []) { self.script = script }

    func setDelegate(_ delegate: TusTransportDelegate?) async { lock.withLock { self.delegate = delegate } }

    func createUpload(_ request: TusCreateRequest) async throws -> URL {
        try lock.withLock {
            ingestTokensSeen.append(request.ingestToken)
            if let valid = validIngestToken, request.ingestToken != valid { throw TusError.authenticationRequired }
            creates.append(request)
            if created { throw TusError.unauthorized }
            created = true
            uploadURL = request.endpoint.appendingPathComponent(request.metadata["upload_session_id"] ?? "abc123")
            let b: CreateBehavior = createScript.isEmpty ? .ok : createScript.removeFirst()
            if case .lostResponse = b { throw TusError.transport("reset") }
            return uploadURL
        }
    }

    func currentOffset(uploadURL: URL, token: String, ingestToken: String?) async throws -> Int64 {
        try lock.withLock {
            headCalls += 1
            ingestTokensSeen.append(ingestToken)
            if let valid = validIngestToken, ingestToken != valid { throw TusError.authenticationRequired }
            if let e = headError { throw e }
            guard created, uploadURL == self.uploadURL else { throw TusError.gone }
            return serverOffset
        }
    }

    func schedulePatch(_ request: TusPatchRequest) async throws {
        let data = try Data(contentsOf: request.chunkFile)
        let (target, outcome): (TusTransportDelegate?, TusPatchOutcome?) = lock.withLock {
            ingestTokensSeen.append(request.ingestToken)
            if let valid = validIngestToken, request.ingestToken != valid { return (self.delegate, .failed(.authenticationRequired)) }
            patches.append((request.chunk.offset, request.chunk.length))
            let b: Behavior = script.isEmpty ? .ok : script.removeFirst()
            if request.chunk.offset != serverOffset { return (self.delegate, .failed(.offsetMismatch)) }
            switch b {
            case .ok:
                serverBytes.append(data); serverOffset += Int64(data.count)
                if let r = rotateIngestTokenAfterPatches, patches.count == r.count { validIngestToken = r.to }
                return (self.delegate, .completed(newOffset: serverOffset))
            case .partial(let n):
                serverBytes.append(data.prefix(Int(n))); serverOffset += n
                return (self.delegate, .failed(.transport("reset")))
            case .fail(let e):
                return (self.delegate, .failed(e))
            case .hang:
                activeKeys.insert(request.key); pendingKeys.append(request.key)
                return (self.delegate, nil)
            }
        }
        if let outcome { Task { await target?.patchDidFinish(request.key, outcome) } }
    }

    func activePatchKeys() async -> Set<TusTaskKey> { lock.withLock { activeKeys } }
    func cancel(uploadId: UUID) async { lock.withLock { activeKeys = activeKeys.filter { $0.uploadId != uploadId } } }

    /// يُكمل مهمة معلّقة كما لو أن النظام أنهى المهمة الخلفية بعد عودة التطبيق.
    func finishHanging(accepting data: Data) async {
        let (key, target): (TusTaskKey?, TusTransportDelegate?) = lock.withLock {
            guard !pendingKeys.isEmpty else { return (nil, nil) }
            let k = pendingKeys.removeFirst(); activeKeys.remove(k)
            serverBytes.append(data); serverOffset += Int64(data.count)
            return (k, self.delegate)
        }
        if let key { await target?.patchDidFinish(key, .completed(newOffset: lock.withLock { serverOffset })) }
    }
}

final class FakeUploadAPI: UploadAPI, @unchecked Sendable {
    let lock = NSLock()
    var createBodies: [UploadSessionCreate] = []
    var completeCalls: [String?] = []
    var completeError: UploadAPIError?
    var createError: UploadAPIError?
    var createFailuresBeforeSuccess = 0
    /// حالات الجلسة التي يعيدها الخادم عند كل استطلاع بالترتيب؛ الأخيرة تتكرر.
    var states: [UploadSession.State] = [.completed, .verified]
    var failureReason: UploadSession.FailureReason?
    var ingestTokenRequired: Bool?
    var polls = 0
    let sessionId = UUID()
    let token = "upload-token-secret"

    func createSession(idempotencyKey: String, _ body: UploadSessionCreate) async throws -> UploadSessionCreated {
        try lock.withLock {
            createBodies.append(body)
            if createFailuresBeforeSuccess > 0 { createFailuresBeforeSuccess -= 1; throw UploadAPIError.transport }
            if let e = createError { throw e }
        }
        return UploadSessionCreated(id: sessionId, materialId: body.materialId, kind: .original, state: .created, sizeBytes: body.sizeBytes,
                                    tusEndpoint: "https://ingest.example.invalid/files/", tusMetadata: UploadSessionTusMetadata(uploadSessionId: sessionId),
                                    partSizeBytes: 16_777_216, bytesReceived: 0, ingestTokenRequired: lock.withLock { ingestTokenRequired },
                                    expiresAt: Date().addingTimeInterval(3600), createdAt: Date(),
                                    uploadToken: token, uploadTokenExpiresAt: Date().addingTimeInterval(3600))
    }

    func session(id: UUID) async throws -> UploadSession {
        let (state, reason) = lock.withLock { polls += 1; return (states[min(polls, states.count) - 1], failureReason) }
        return UploadSession(id: id, materialId: UUID(), kind: .original, state: state, sizeBytes: 1, tusEndpoint: "https://ingest.example.invalid/files/",
                             tusMetadata: UploadSessionTusMetadata(uploadSessionId: id), partSizeBytes: 16_777_216, bytesReceived: 1, expiresAt: Date(),
                             duplicateOfFileId: state == .deduplicated ? UUID(uuidString: "11111111-1111-4111-8111-111111111111") : nil,
                             failureReason: reason, receiptNumber: state == .verified ? "R-202610-000042" : nil, createdAt: Date())
    }

    func complete(idempotencyKey: String, id: UUID, reportedSha256: String?) async throws {
        try lock.withLock { completeCalls.append(reportedSha256); if let e = completeError { throw e } }
    }
}

enum Fixtures {
    static func tempDir(_ name: String) -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("uploadcore-\(name)-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func sourceFile(in dir: URL, bytes: Int) -> (URL, Data) {
        var data = Data(count: bytes)
        for i in 0..<bytes { data[i] = UInt8((i * 7 + 3) & 0xff) }
        let url = dir.appendingPathComponent("clip.mov")
        try! data.write(to: url)
        return (url, data)
    }

    static var fastTiming: UploadEngine.Timing {
        var t = UploadEngine.Timing()
        t.retryDelays = [0.01]
        t.receiptPollInterval = 0.01
        return t
    }

    static var smallChunks: ChunkSizePolicy {
        var p = ChunkSizePolicy()
        p.foregroundBytes = 4
        p.preparedWindow = 2
        return p
    }
}

extension UploadEngine {
    func waitUntil(_ id: UUID, timeout: TimeInterval = 5, _ predicate: @escaping (UploadRecord) -> Bool) async -> UploadRecord? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let r = record(id), predicate(r) { return r }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return record(id)
    }
}

/// مصدر رموز ingest محاكى: يصدر رموزًا مرقّمة، ويسجّل الطلبات القسرية والنسيان.
final class FakeIngestTokens: IngestTokenProvider, @unchecked Sendable {
    let lock = NSLock()
    var issued = 0
    var forced = 0
    var forgotten: [UUID] = []
    var error: IngestTokenError?
    var cached: [UUID: String] = [:]

    func ingestToken(uploadSessionId: UUID, forceRefresh: Bool) async throws -> String {
        try lock.withLock {
            if let error { throw error }
            if forceRefresh { forced += 1; cached[uploadSessionId] = nil }
            if let t = cached[uploadSessionId] { return t }
            issued += 1
            let t = "ingest-\(issued)"
            cached[uploadSessionId] = t
            return t
        }
    }

    func forget(uploadSessionId: UUID) async { lock.withLock { forgotten.append(uploadSessionId); cached[uploadSessionId] = nil } }
    var current: String? { lock.withLock { cached.values.first } }
}
