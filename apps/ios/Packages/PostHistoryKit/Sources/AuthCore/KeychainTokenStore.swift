import Foundation

#if canImport(Security)
import Security

/// الجلسة في Keychain كعنصر `kSecClassGenericPassword` واحد (JSON)، متاح بعد أول فتح للجهاز فقط وغير قابل للنقل
/// بالنسخ الاحتياطي (`ThisDeviceOnly`). الرموز لا تُكتب في UserDefaults ولا في الملفات ولا في السجل.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    public enum KeychainError: Error, Equatable { case unexpectedStatus(OSStatus) }

    private let service: String
    private let account: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(service: String = "post-history.session", account: String = "current") {
        self.service = service
        self.account = account
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() throws -> StoredSession? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError.unexpectedStatus(status) }
        return try decoder.decode(StoredSession.self, from: data)
    }

    public func save(_ session: StoredSession) throws {
        let data = try encoder.encode(session)
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError.unexpectedStatus(update) }
        let add = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        guard add == errSecSuccess else { throw KeychainError.unexpectedStatus(add) }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.unexpectedStatus(status) }
    }
}
#endif
