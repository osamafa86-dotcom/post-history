import Foundation
import PostHistoryAPI
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// جلسة API بلا أي ذاكرة على القرص: `ephemeral` بلا `URLCache` ولا كعكات، فلا تبقى أجسام الاستجابات (عناوين المواد، الأماكن،
/// الإشعارات) في `Library/Caches` حتى لو أغفل الخادم `Cache-Control: no-store`. يستعملها كل طلب من العميل المولَّد.
public enum NoCacheAPISession {
    public static func makeConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        return c
    }

    public static let shared = URLSession(configuration: makeConfiguration())
}

final class NoCacheRequestBuilder<T: Sendable>: URLSessionRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol { NoCacheAPISession.shared }
}

final class NoCacheDecodableRequestBuilder<T: Decodable & Sendable>: URLSessionDecodableRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol { NoCacheAPISession.shared }
}

public struct NoCacheRequestBuilderFactory: RequestBuilderFactory {
    public init() {}
    public func getNonDecodableBuilder<T>() -> RequestBuilder<T>.Type { NoCacheRequestBuilder<T>.self }
    public func getBuilder<T: Decodable>() -> RequestBuilder<T>.Type { NoCacheDecodableRequestBuilder<T>.self }
}

extension PostHistoryAPIAPIConfiguration {
    /// إعداد العميل المولَّد للتطبيق: جلسة بلا ذاكرة على القرص، ومعترض اختياري (Bearer والتحديث).
    public static func noCache(basePath: String, interceptor: OpenAPIInterceptor? = nil) -> PostHistoryAPIAPIConfiguration {
        if let interceptor {
            return PostHistoryAPIAPIConfiguration(basePath: basePath, requestBuilderFactory: NoCacheRequestBuilderFactory(), interceptor: interceptor)
        }
        return PostHistoryAPIAPIConfiguration(basePath: basePath, requestBuilderFactory: NoCacheRequestBuilderFactory())
    }
}
