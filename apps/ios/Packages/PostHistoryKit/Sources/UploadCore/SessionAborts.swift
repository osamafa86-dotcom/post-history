import Foundation

/// جلسة سجل ألغاه المراسل وما زالت على الخادم: تُنهى بـ `DELETE /uploads/{id}` (ADR 0113، كما `upload_aborts` في أندرويد،
/// ADR 0112). المفتاح ثابت للسجل ويُعاد مع كل محاولة؛ والطلب باسم صاحب السجل وحده (ADR 0093).
public struct PendingAbort: Codable, Equatable, Sendable {
    public var sessionId: UUID
    /// صاحب السجل بمعرّفه المحلي المعتم (`LocalAccounts`)، لا بريده ولا معرّفه على الخادم.
    public var ownerAccount: UUID?
    public var idempotencyKey: String
    public var createdAt: Date

    public init(sessionId: UUID, ownerAccount: UUID?, idempotencyKey: String, createdAt: Date) {
        self.sessionId = sessionId
        self.ownerAccount = ownerAccount
        self.idempotencyKey = idempotencyKey
        self.createdAt = createdAt
    }

    /// مفتاح الإجهاض الثابت لسجل: يُعاد مع كل محاولة، فإعادة الطلب بعد انقطاع لا تُحسب طلبًا ثانيًا.
    public static func idempotencyKey(forRecord id: UUID) -> String { "upload-abort-\(id.uuidString.lowercased())" }
}

/// أين تنتظر الإجهاضات: ملف بحماية سجلات الرفع على الجهاز، والذاكرة في الاختبار. يمحوها المسح الطارئ والإبطال مع الطابور.
public protocol AbortStore: Sendable {
    /// يُبقي الإجهاض ما لم تكن جلسته محفوظة من قبل؛ يرمي إن تعذّرت الكتابة الآن.
    func add(_ abort: PendingAbort) throws
    /// الأقدم أولًا.
    func all() throws -> [PendingAbort]
    func remove(sessionId: UUID) throws
    func removeAll() throws
}

public final class InMemoryAbortStore: AbortStore, @unchecked Sendable {
    private let lock = NSLock()
    private var aborts: [PendingAbort] = []
    public init() {}
    public func add(_ abort: PendingAbort) throws {
        lock.withLock { if !aborts.contains(where: { $0.sessionId == abort.sessionId }) { aborts.append(abort) } }
    }
    public func all() throws -> [PendingAbort] { lock.withLock { aborts.sorted { $0.createdAt < $1.createdAt } } }
    public func remove(sessionId: UUID) throws { lock.withLock { aborts.removeAll { $0.sessionId == sessionId } } }
    public func removeAll() throws { lock.withLock { aborts.removeAll() } }
}

/// ملف واحد بقائمة الإجهاضات، يُكتب ذريًا بحماية سجلات الرفع (`UploadFileProtection`). لا امتداد `.json` له لأن مخزن الحالة يقرأ
/// كل JSON في مجلده سجلَّ رفع. ملف لا يُقرأ (الهاتف مقفل قبل أول فتح) يرمي ولا يُستبدل.
public final class FileAbortStore: AbortStore, @unchecked Sendable {
    public let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL) { self.fileURL = fileURL }

    public func add(_ abort: PendingAbort) throws {
        try lock.withLock {
            var current = try read()
            guard !current.contains(where: { $0.sessionId == abort.sessionId }) else { return }
            current.append(abort)
            try write(current)
        }
    }

    public func all() throws -> [PendingAbort] { try lock.withLock { try read().sorted { $0.createdAt < $1.createdAt } } }

    public func remove(sessionId: UUID) throws {
        try lock.withLock {
            let current = try read()
            let kept = current.filter { $0.sessionId != sessionId }
            if kept.count != current.count { try write(kept) }
        }
    }

    public func removeAll() throws {
        try lock.withLock {
            if FileManager.default.fileExists(atPath: fileURL.path) { try FileManager.default.removeItem(at: fileURL) }
        }
    }

    private func read() throws -> [PendingAbort] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([PendingAbort].self, from: Data(contentsOf: fileURL))
    }

    private func write(_ aborts: [PendingAbort]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(aborts).write(to: fileURL, options: UploadFileProtection.writingOptions)
    }
}
