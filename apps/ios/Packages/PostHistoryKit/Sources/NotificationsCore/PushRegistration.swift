import Foundation
import PostHistoryAPI

/// `PUT /push-devices` و`DELETE /push-devices/{installation_id}` كما يحتاجهما التطبيق.
public protocol PushDevicesAPI: Sendable {
    func register(installationId: UUID, token: String, appVersion: String?) async throws
    func unregister(installationId: UUID) async throws
}

public struct GeneratedPushDevicesAPI: PushDevicesAPI {
    private let configuration: PostHistoryAPIAPIConfiguration
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }

    public func register(installationId: UUID, token: String, appVersion: String?) async throws {
        let body = PushDeviceRegistration(installationId: installationId, platform: .ios, token: token, appVersion: appVersion)
        try await NotificationsAPI.registerPushDevice(idempotencyKey: UUID().uuidString, pushDeviceRegistration: body, apiConfiguration: configuration)
    }

    public func unregister(installationId: UUID) async throws {
        try await NotificationsAPI.unregisterPushDevice(idempotencyKey: UUID().uuidString, installationId: installationId, apiConfiguration: configuration)
    }
}

/// معرّف التثبيت: يولّده التطبيق عند أول حاجة، وليس مشتقًا من أي معرّف للجهاز (العقد). يُحذف في المسح الطارئ.
public protocol InstallationIdStore: Sendable {
    func load() throws -> UUID?
    func save(_ id: UUID) throws
    func remove() throws
}

public final class InMemoryInstallationIdStore: InstallationIdStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: UUID?
    public init(_ value: UUID? = nil) { self.value = value }
    public func load() throws -> UUID? { lock.withLock { value } }
    public func save(_ id: UUID) throws { lock.withLock { value = id } }
    public func remove() throws { lock.withLock { value = nil } }
}

/// يسجّل رمز APNs لدى الخادم بعد الدخول، ولا يعيد التسجيل إن لم يتغير الرمز، ويلغيه عند الخروج والمسح.
/// الرمز لا يُسجَّل ولا يُحفظ على القرص؛ يُحفظ في الذاكرة لإعادة التسجيل بعد دخول جديد.
public actor PushRegistrar {
    private let api: any PushDevicesAPI
    private let ids: any InstallationIdStore
    private let appVersion: String?
    private var deviceToken: String?
    private var registeredToken: String?
    private var signedIn = false

    public init(api: any PushDevicesAPI, ids: any InstallationIdStore, appVersion: String?) {
        self.api = api
        self.ids = ids
        self.appVersion = appVersion
    }

    /// من `didRegisterForRemoteNotificationsWithDeviceToken`.
    public func deviceTokenReceived(_ token: Data) async {
        deviceToken = Self.hex(token)
        await registerIfNeeded()
    }

    public func didSignIn() async {
        signedIn = true
        registeredToken = nil // حساب آخر ربما: يُسجَّل الجهاز له من جديد
        await registerIfNeeded()
    }

    /// الخروج: يُلغى الجهاز على الخادم بأفضل جهد قبل ذهاب رمز الدخول.
    public func willSignOut() async {
        signedIn = false
        registeredToken = nil
        if let id = try? ids.load() { try? await api.unregister(installationId: id) }
    }

    /// الإبطال أو المسح الطارئ: لا اتصال مطلوب؛ يُنسى المعرّف فيولَّد غيره بعد الدخول التالي.
    public func forgetLocally() {
        signedIn = false
        registeredToken = nil
        deviceToken = nil
        try? ids.remove()
    }

    public var isRegistered: Bool { registeredToken != nil }

    private func registerIfNeeded() async {
        guard signedIn, let token = deviceToken, token != registeredToken else { return }
        guard let id = installationId() else { return }
        do {
            try await api.register(installationId: id, token: token, appVersion: appVersion)
            registeredToken = token
        } catch {
            // يُعاد عند الإطلاق التالي أو الرمز التالي؛ لا تسجيل للرمز في السجلات.
        }
    }

    private func installationId() -> UUID? {
        if let existing = try? ids.load() { return existing }
        let fresh = UUID()
        guard (try? ids.save(fresh)) != nil else { return nil }
        return fresh
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}

#if canImport(Security)
import Security

/// معرّف التثبيت في Keychain (`AfterFirstUnlockThisDeviceOnly`): لا ينتقل بالنسخ الاحتياطي إلى جهاز آخر.
public final class KeychainInstallationIdStore: InstallationIdStore, @unchecked Sendable {
    private let query: [String: Any]
    public init(service: String = "post-history.installation") {
        query = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "installation-id"]
    }

    public func load() throws -> UUID? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return UUID(uuidString: String(decoding: data, as: UTF8.self))
    }

    public func save(_ id: UUID) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(id.uuidString.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess { return }
        let status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public func remove() throws { SecItemDelete(query as CFDictionary) }
}
#endif
