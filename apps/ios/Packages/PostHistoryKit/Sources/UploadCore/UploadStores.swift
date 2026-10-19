import Foundation

/// حالة الرفع على القرص: ملف JSON لكل سجل يُكتب ذريًا. يبقى بعد إنهاء التطبيق وإعادة تشغيل الجهاز.
public protocol UploadStateStore: Sendable {
    func loadAll() throws -> [UploadRecord]
    func save(_ record: UploadRecord) throws
    func remove(id: UUID) throws
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

    public func loadAll() throws -> [UploadRecord] {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        return try files.map { try decoder.decode(UploadRecord.self, from: Data(contentsOf: $0)) }.sorted { $0.createdAt < $1.createdAt }
    }

    public func save(_ record: UploadRecord) throws {
        try encoder.encode(record).write(to: url(record.id), options: .atomic)
    }

    public func remove(id: UUID) throws {
        let u = url(id)
        if FileManager.default.fileExists(atPath: u.path) { try FileManager.default.removeItem(at: u) }
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
}
#endif

public enum UploadStoreError: Error, Equatable {
    case keychain(Int32)
    case missingToken
}
