import Foundation

/// حماية الملفات على iOS: مقروءة بعد أول فتح للجهاز فقط (تطابق Keychain `AfterFirstUnlock`)؛ الحماية الكاملة تمنع القراءة حين يوقظ
/// النظام التطبيق لحدث جلسة خلفية والجهاز مقفل. على المنصات الأخرى لا خيار.
public enum UploadFileProtection {
    public static var writingOptions: Data.WritingOptions {
        #if os(iOS)
        return [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        return [.atomic]
        #endif
    }
    public static var attributes: [FileAttributeKey: Any] {
        #if os(iOS)
        return [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        return [:]
        #endif
    }
}

/// حالة الرفع على القرص: ملف JSON لكل سجل يُكتب ذريًا بحماية الملفات. يبقى بعد إنهاء التطبيق وإعادة تشغيل الجهاز.
/// يحمل رابط رفع tus (قدرة بحد ذاتها بعد `pre-create`)، فالمجلد يُستثنى من النسخ الاحتياطي في التطبيق ولا يُنسخ خارج الجهاز.
public protocol UploadStateStore: Sendable {
    func loadAll() throws -> [UploadRecord]
    /// السجلات المقروءة، وعدد ما لم يُقرأ ملفه وما لم يُفك ترميزه: النواة تعلنهما ولا تُسقطهما صامتةً (ADR 0113).
    func loadSnapshot() throws -> UploadStoreSnapshot
    func save(_ record: UploadRecord) throws
    func remove(id: UUID) throws
    /// يحذف كل ما في المخزن، ومنه ما لم يُقرأ أو لم يُفك ترميزه: المسح الطارئ لا يُبقي رابط رفع على الهاتف.
    func removeAll() throws
}

/// ما وجده المخزن عند القراءة. الأعداد وحدها تخرج منه: لا مسار ولا اسم ملف.
public struct UploadStoreSnapshot: Sendable {
    public var records: [UploadRecord]
    public var unreadable: Int
    public var undecodable: Int

    public init(records: [UploadRecord], unreadable: Int = 0, undecodable: Int = 0) {
        self.records = records
        self.unreadable = unreadable
        self.undecodable = undecodable
    }
}

public extension UploadStateStore {
    /// مخزن لا يميّز ما لم يقرأه: كل ما يعيده `loadAll`.
    func loadSnapshot() throws -> UploadStoreSnapshot { try UploadStoreSnapshot(records: loadAll()) }
    func removeAll() throws { for record in try loadAll() { try remove(id: record.id) } }
}

/// رمز الرفع القصير لكل سجل؛ على الجهاز في Keychain، لا في ملف الحالة.
public protocol UploadSecretStore: Sendable {
    func token(for id: UUID) throws -> String?
    func setToken(_ token: String, for id: UUID) throws
    func removeToken(for id: UUID) throws
}

public final class InMemoryUploadStateStore: UploadStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [UUID: UploadRecord] = [:]
    public init() {}
    public func loadAll() throws -> [UploadRecord] { lock.withLock { records.values.sorted { $0.createdAt < $1.createdAt } } }
    public func save(_ record: UploadRecord) throws { lock.withLock { records[record.id] = record } }
    public func remove(id: UUID) throws { lock.withLock { _ = records.removeValue(forKey: id) } }
}

public final class InMemoryUploadSecretStore: UploadSecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [UUID: String] = [:]
    public init() {}
    public func token(for id: UUID) throws -> String? { lock.withLock { tokens[id] } }
    public func setToken(_ token: String, for id: UUID) throws { lock.withLock { tokens[id] = token } }
    public func removeToken(for id: UUID) throws { lock.withLock { _ = tokens.removeValue(forKey: id) } }
}

public final class FileUploadStateStore: UploadStateStore, @unchecked Sendable {
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    private func url(_ id: UUID) -> URL { directory.appendingPathComponent("\(id.uuidString.lowercased()).json") }

    /// كل سجل يُقرأ وحده: ملف لا يُقرأ (الهاتف مقفل قبل أول فتح منذ التشغيل، أو ملف تالف) يُترك ولا يُخفي غيره. كان ملف واحد كذلك
    /// يرمي القراءة كلها، فتبدأ النواة بطابور فارغ في الذاكرة: لا رفع يُستأنف، ولا ترى «موادي» أصلًا على الهاتف (بناء 1.0 (11)).
    public func loadAll() throws -> [UploadRecord] { try loadSnapshot().records }

    /// ما لم يُقرأ وما لم يُفك ترميزه يُعدّ ويبقى ملفه في مكانه: قد يقرؤه فتح لاحق للهاتف أو إصدار لاحق، ولا يُحذف إلا بالمسح.
    public func loadSnapshot() throws -> UploadStoreSnapshot {
        var records: [UploadRecord] = []
        var unreadable = 0
        var undecodable = 0
        for file in try recordFiles() {
            guard let data = try? Data(contentsOf: file) else {
                unreadable += 1
                continue
            }
            if let record = try? decoder.decode(UploadRecord.self, from: data) {
                records.append(record)
            } else {
                undecodable += 1
            }
        }
        return UploadStoreSnapshot(records: records.sorted { $0.createdAt < $1.createdAt }, unreadable: unreadable, undecodable: undecodable)
    }

    private func recordFiles() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
    }

    public func save(_ record: UploadRecord) throws {
        try encoder.encode(record).write(to: url(record.id), options: UploadFileProtection.writingOptions)
    }

    public func remove(id: UUID) throws {
        let u = url(id)
        if FileManager.default.fileExists(atPath: u.path) { try FileManager.default.removeItem(at: u) }
    }

    public func removeAll() throws {
        for file in try recordFiles() { try FileManager.default.removeItem(at: file) }
    }
}

#if canImport(Security)
import Security

public final class KeychainUploadSecretStore: UploadSecretStore, @unchecked Sendable {
    private let service: String
    public init(service: String = "post-history.upload-token") { self.service = service }

    private func query(_ id: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString.lowercased()]
    }

    public func token(for id: UUID) throws -> String? {
        var q = query(id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw UploadStoreError.keychain(status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setToken(_ token: String, for id: UUID) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(query(id) as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw UploadStoreError.keychain(update) }
        let add = SecItemAdd(query(id).merging(attributes) { $1 } as CFDictionary, nil)
        guard add == errSecSuccess else { throw UploadStoreError.keychain(add) }
    }

    public func removeToken(for id: UUID) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw UploadStoreError.keychain(status) }
    }

    /// يحذف كل رموز الرفع (أول تشغيل بعد تثبيت جديد؛ المسح الطارئ لاحقًا).
    public func removeAll() throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw UploadStoreError.keychain(status) }
    }
}
#endif

public enum UploadStoreError: Error, Equatable {
    case keychain(Int32)
    case missingToken
}
