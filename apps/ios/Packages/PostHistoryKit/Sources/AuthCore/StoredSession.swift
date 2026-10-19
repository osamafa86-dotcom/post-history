import Foundation
import PostHistoryAPI

/// الجلسة كما تُحفظ على الجهاز (Keychain): رمز الوصول ورمز التحديث وانتهاء الوصول والهوية.
/// النموذج مشتق من `Session` المولَّد من العقد؛ لا حقول إضافية.
public struct StoredSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var userId: UUID
    public var roles: [Role]

    public init(_ session: Session) {
        accessToken = session.accessToken
        refreshToken = session.refreshToken
        expiresAt = session.expiresAt
        userId = session.userId
        roles = session.roles
    }

    public init(accessToken: String, refreshToken: String, expiresAt: Date, userId: UUID, roles: [Role]) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userId = userId
        self.roles = roles
    }
}
