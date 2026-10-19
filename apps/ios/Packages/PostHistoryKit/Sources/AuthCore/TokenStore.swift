import Foundation

/// مخزن الجلسة. التنفيذ الفعلي على الجهاز `KeychainTokenStore`؛ `InMemoryTokenStore` للاختبارات فقط.
public protocol TokenStore: Sendable {
    func load() throws -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear() throws
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: StoredSession?
    public private(set) var saveCount = 0
    public private(set) var clearCount = 0

    public init(_ session: StoredSession? = nil) { self.session = session }

    public func load() throws -> StoredSession? { lock.withLock { session } }
    public func save(_ session: StoredSession) throws { lock.withLock { self.session = session; saveCount += 1 } }
    public func clear() throws { lock.withLock { session = nil; clearCount += 1 } }
}
