import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PostHistoryAPI

/// أخطاء الهوية كما يتفرّع عليها التطبيق؛ الرسائل البشرية في موارد التطبيق لا هنا.
public enum AuthError: Error, Equatable, Sendable {
    case notSignedIn
    /// رمز التحديث مرفوض (أُبطل أو انتهى): تُمسح الجلسة المحلية ويلزم دخول جديد.
    case sessionExpired
    case totpRequired
    case unauthorized
    case rateLimited(retryAfterSeconds: Int?)
    case validation
    /// أي استجابة أخرى من الخادم: الرمز الثابت من `Error.code` إن وُجد ورقم الحالة.
    case server(code: String?, status: Int)
    /// تعذّر الوصول إلى الخادم أصلًا (شبكة، مهلة).
    case transport(String)
}

public enum APIErrorMapper {
    /// يحوّل خطأ العميل المولَّد إلى `AuthError` اعتمادًا على `Error.code` في جسم الاستجابة.
    public static func map(_ error: any Error) -> AuthError {
        if let auth = error as? AuthError { return auth }
        guard case let ErrorResponse.error(status, data, response, _) = error else {
            return .transport(String(describing: type(of: error)))
        }
        if status <= 0 { return .transport("no_response") }
        let code = data.flatMap { try? JSONDecoder().decode(ModelError.self, from: $0) }?.code
        switch (status, code) {
        case (401, .totpRequired): return .totpRequired
        case (401, _): return .unauthorized
        case (429, _):
            let header = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After")
            return .rateLimited(retryAfterSeconds: header.flatMap(Int.init))
        case (422, _): return .validation
        default: return .server(code: code?.rawValue, status: status)
        }
    }
}
