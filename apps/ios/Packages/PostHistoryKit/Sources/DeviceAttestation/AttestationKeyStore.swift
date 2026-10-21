import Foundation

/// معرّف مفتاح App Attest لهذا التثبيت. معرّف تثبيت (بيانات كاشفة): في Keychain فقط، ويُحذف في المسح الطارئ.
public protocol AttestationKeyStore: Sendable {
    func keyId() throws -> String?
    func setKeyId(_ keyId: String) throws
    func removeKeyId() throws
}

public final class InMemoryAttestationKeyStore: AttestationKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    public init(keyId: String? = nil) { value = keyId }
    public func keyId() throws -> String? { lock.withLock { value } }
    public func setKeyId(_ keyId: String) throws { lock.withLock { value = keyId } }
    public func removeKeyId() throws { lock.withLock { value = nil } }
}

public enum AttestationKeyStoreError: Error, Equatable {
    case keychain(Int32)
}

#if canImport(Security)
import Security

public final class KeychainAttestationKeyStore: AttestationKeyStore, @unchecked Sendable {
    private let service: String
    private let account = "app-attest-key"
    public init(service: String = "post-history.app-attest") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func keyId() throws -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw AttestationKeyStoreError.keychain(status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setKeyId(_ keyId: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(keyId.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw AttestationKeyStoreError.keychain(update) }
        let add = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        guard add == errSecSuccess else { throw AttestationKeyStoreError.keychain(add) }
    }

    public func removeKeyId() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AttestationKeyStoreError.keychain(status) }
    }
}
#endif
