import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// مفتاح مهمة PATCH في جلسة URLSession: يُحفظ في `taskDescription` كي يُربط الحدث بالسجل بعد إعادة تشغيل التطبيق.
public struct TusTaskKey: Hashable, Sendable, CustomStringConvertible {
    public var uploadId: UUID
    public var offset: Int64
    public init(uploadId: UUID, offset: Int64) { self.uploadId = uploadId; self.offset = offset }
    public var description: String { "\(uploadId.uuidString.lowercased())|\(offset)" }
    public init?(_ string: String) {
        let parts = string.split(separator: "|")
        guard parts.count == 2, let id = UUID(uuidString: String(parts[0])), let off = Int64(parts[1]) else { return nil }
        self.init(uploadId: id, offset: off)
    }
}

public struct TusCreateRequest: Sendable, Equatable {
    public var endpoint: URL
    public var token: String
    public var length: Int64
    public var metadata: [String: String]
    public init(endpoint: URL, token: String, length: Int64, metadata: [String: String]) {
        self.endpoint = endpoint; self.token = token; self.length = length; self.metadata = metadata
    }

    /// `Upload-Metadata`: أزواج `key base64(value)` مفصولة بفاصلة، بترتيب المفاتيح كي تكون ثابتة.
    public var metadataHeader: String {
        metadata.keys.sorted().map { "\($0) \(Data(metadata[$0]!.utf8).base64EncodedString())" }.joined(separator: ",")
    }
}

public struct TusPatchRequest: Sendable, Equatable {
    public var key: TusTaskKey
    public var uploadURL: URL
    public var token: String
    public var chunk: PreparedChunk
    public var chunkFile: URL
    public init(key: TusTaskKey, uploadURL: URL, token: String, chunk: PreparedChunk, chunkFile: URL) {
        self.key = key; self.uploadURL = uploadURL; self.token = token; self.chunk = chunk; self.chunkFile = chunkFile
    }
}

public enum TusError: Error, Equatable, Sendable {
    /// `409`: موضع الطلب يخالف موضع الخادم؛ يُسأل الخادم (HEAD) ويُستأنف من عنده.
    case offsetMismatch
    /// انقطاع أو مهلة أو إلغاء من النظام؛ يُعاد بعد مهلة.
    case transport(String)
    /// `423`: الخادم يحتفظ بقفل على الرفع (مهمة قديمة ما زالت تكتب)؛ يُعاد لاحقًا.
    case locked
    /// `401`/`403`: الرمز انتهى أو أُبطل.
    case unauthorized
    /// `404`/`410`: الرفع لم يعد موجودًا.
    case gone
    /// `460`: بصمة الجزء خالفت ما وصل (tus checksum extension؛ لا يُرسل التطبيق بصمة، يبقى للتصنيف)؛ يُعاد إرسال الجزء.
    case checksumMismatch
    /// حالة أخرى غير قابلة للإعادة.
    case http(Int)
    case cancelled

    public var isRetryable: Bool {
        switch self {
        case .offsetMismatch, .transport, .locked, .checksumMismatch, .cancelled: return true
        case .unauthorized, .gone, .http: return false
        }
    }

    public static func fromStatus(_ status: Int) -> TusError {
        switch status {
        case 409: return .offsetMismatch
        case 423: return .locked
        case 401, 403: return .unauthorized
        case 404, 410: return .gone
        case 460: return .checksumMismatch
        default: return .http(status)
        }
    }
}

public enum TusPatchOutcome: Equatable, Sendable {
    case completed(newOffset: Int64)
    case failed(TusError)
}

/// يستقبل نتائج مهام PATCH التي قد تكتمل بعد إعادة تشغيل التطبيق.
public protocol TusTransportDelegate: AnyObject, Sendable {
    func patchDidFinish(_ key: TusTaskKey, _ outcome: TusPatchOutcome) async
}

/// نقل tus 1.0. الإنشاء وHEAD طلبان قصيران ينتظران؛ PATCH يُجدوَل (جلسة خلفية على الجهاز) وتصل نتيجته عبر المفوَّض.
public protocol TusTransport: Sendable {
    func setDelegate(_ delegate: TusTransportDelegate?) async
    func createUpload(_ request: TusCreateRequest) async throws -> URL
    func currentOffset(uploadURL: URL, token: String) async throws -> Int64
    func schedulePatch(_ request: TusPatchRequest) async throws
    /// مفاتيح مهام PATCH التي ما زالت في النظام (بعد إعادة التشغيل): لا يُعاد إرسالها بل يُنتظر حدثها.
    func activePatchKeys() async -> Set<TusTaskKey>
    func cancel(uploadId: UUID) async
}

/// التنفيذ عبر URLSession بمفوَّض؛ الجلسة تُحقن: خلفية (`background(withIdentifier:)`) على الجهاز، عادية في الاختبارات.
/// مهام الرفع من ملف (`uploadTask(with:fromFile:)`) هي الوحيدة المسموح بها في الجلسة الخلفية.
public final class URLSessionTusTransport: NSObject, TusTransport, URLSessionDataDelegate, @unchecked Sendable {
    public static let tusVersion = "1.0.0"

    private let lock = NSLock()
    private var session: URLSession!
    private weak var delegate: TusTransportDelegate?
    private var responses: [Int: HTTPURLResponse] = [:]
    /// آخر تقدم في إرسال الجسم لكل مهمة PATCH (مراقب الخمول).
    private var lastProgress: [Int: Date] = [:]
    private let idleTimeout: TimeInterval?
    private var watchdog: Task<Void, Never>?
    /// يُستدعى بعد معالجة كل أحداث الجلسة الخلفية (من `handleEventsForBackgroundURLSession`).
    public var backgroundCompletionHandler: (@Sendable () -> Void)?

    /// `idleTimeout`: مهلة خمول صريحة لمهام PATCH تُقاس على تقدم إرسال الجسم (`didSendBodyData`)؛ تجاوزها يلغي المهمة
    /// فيستأنف المحرّك من موضع الخادم. لازمة على Linux حيث `timeoutIntervalForRequest` مهلة للطلب كله لا للخمول
    /// (قياس netlab: كل PATCH من 1 MiB عند 86 kbit/s يُقطع عند 60 ث)؛ على منصات Apple المهلة النظامية خمولٌ أصلًا.
    public init(configuration: URLSessionConfiguration, idleTimeout: TimeInterval? = nil) {
        self.idleTimeout = idleTimeout
        super.init()
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        if let idleTimeout {
            watchdog = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    await self?.cancelIdleTasks(olderThan: idleTimeout)
                }
            }
        }
    }

    deinit { watchdog?.cancel() }

    private func cancelIdleTasks(olderThan timeout: TimeInterval) async {
        let stale: Set<Int> = lock.withLock {
            let cutoff = Date().addingTimeInterval(-timeout)
            return Set(lastProgress.filter { $0.value < cutoff }.map(\.key))
        }
        guard !stale.isEmpty else { return }
        for task in await allTasks() where stale.contains(task.taskIdentifier) { task.cancel() }
    }

    public func setDelegate(_ delegate: TusTransportDelegate?) async { lock.withLock { self.delegate = delegate } }

    private func request(_ method: String, _ url: URL, token: String) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue(Self.tusVersion, forHTTPHeaderField: "Tus-Resumable")
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return r
    }

    public func createUpload(_ req: TusCreateRequest) async throws -> URL {
        var r = request("POST", req.endpoint, token: req.token)
        r.setValue(String(req.length), forHTTPHeaderField: "Upload-Length")
        r.setValue(req.metadataHeader, forHTTPHeaderField: "Upload-Metadata")
        r.setValue("0", forHTTPHeaderField: "Content-Length")
        let (_, response) = try await data(for: r)
        guard response.statusCode == 201 else { throw TusError.fromStatus(response.statusCode) }
        guard let location = response.value(forHTTPHeaderField: "Location"), let url = URL(string: location, relativeTo: req.endpoint)?.absoluteURL else {
            throw TusError.http(response.statusCode)
        }
        return url
    }

    public func currentOffset(uploadURL: URL, token: String) async throws -> Int64 {
        let r = request("HEAD", uploadURL, token: token)
        let (_, response) = try await data(for: r)
        guard response.statusCode == 200, let offset = response.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init) else {
            throw TusError.fromStatus(response.statusCode)
        }
        return offset
    }

    public func schedulePatch(_ req: TusPatchRequest) async throws {
        var r = request("PATCH", req.uploadURL, token: req.token)
        r.setValue(String(req.chunk.offset), forHTTPHeaderField: "Upload-Offset")
        r.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: r, fromFile: req.chunkFile)
        task.taskDescription = req.key.description
        if idleTimeout != nil { lock.withLock { lastProgress[task.taskIdentifier] = Date() } }
        task.resume()
    }

    private func allTasks() async -> [URLSessionTask] {
        await withCheckedContinuation { c in session.getAllTasks { c.resume(returning: $0) } }
    }

    public func activePatchKeys() async -> Set<TusTaskKey> {
        Set(await allTasks().compactMap { $0.taskDescription.flatMap(TusTaskKey.init) })
    }

    public func cancel(uploadId: UUID) async {
        for task in await allTasks() where TusTaskKey(task.taskDescription ?? "")?.uploadId == uploadId { task.cancel() }
    }

    // MARK: URLSession delegate (نتائج PATCH)

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse { lock.withLock { responses[dataTask.taskIdentifier] = http } }
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if idleTimeout != nil { lock.withLock { lastProgress[task.taskIdentifier] = Date() } }
        if Self.debugProgress { FileHandle.standardError.write(Data("tus progress task=\(task.taskIdentifier) sent=\(totalBytesSent)/\(totalBytesExpectedToSend)\n".utf8)) }
    }

    /// تشخيص تقدم الإرسال على stderr (`TUS_TRANSPORT_DEBUG=1`)؛ لا معرّفات ولا مسارات.
    static let debugProgress = ProcessInfo.processInfo.environment["TUS_TRANSPORT_DEBUG"] == "1"

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let key = task.taskDescription.flatMap(TusTaskKey.init) else { return }
        let http = lock.withLock { lastProgress[task.taskIdentifier] = nil; return responses.removeValue(forKey: task.taskIdentifier) } ?? (task.response as? HTTPURLResponse)
        let outcome: TusPatchOutcome
        if let error {
            outcome = .failed((error as? URLError)?.code == .cancelled ? .cancelled : .transport(String((error as NSError).code)))
        } else if let http, http.statusCode == 204, let offset = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init) {
            outcome = .completed(newOffset: offset)
        } else {
            outcome = .failed(TusError.fromStatus(http?.statusCode ?? 0))
        }
        let delegate = lock.withLock { self.delegate }
        Task { await delegate?.patchDidFinish(key, outcome) }
    }

    #if !os(Linux)
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        DispatchQueue.main.async { handler?() }
    }
    #endif

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw TusError.transport("non_http") }
            return (data, http)
        } catch let e as TusError { throw e } catch { throw TusError.transport(String((error as NSError).code)) }
    }
}
