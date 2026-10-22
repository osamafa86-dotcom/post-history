import XCTest
import PostHistoryAPI
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import AuthCore

/// مراجعة الأمن على #173: أجسام استجابات الـ API لا تُكتب في ذاكرة القرص مهما كانت ترويسات الخادم.
final class NoCacheAPISessionTests: XCTestCase {
    func testSessionHasNoURLCacheNorCookies() {
        let c = NoCacheAPISession.shared.configuration
        XCTAssertNil(c.urlCache)
        XCTAssertNil(c.httpCookieStorage)
        XCTAssertFalse(c.httpShouldSetCookies)
        XCTAssertEqual(c.requestCachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
    }

    func testEveryGeneratedRequestUsesTheNoCacheSession() {
        let config = PostHistoryAPIAPIConfiguration.noCache(basePath: "https://api.example.invalid/v1")
        let decodable = config.requestBuilderFactory.getBuilder() as RequestBuilder<MaterialPage>.Type
        let plain = config.requestBuilderFactory.getNonDecodableBuilder() as RequestBuilder<Void>.Type
        let b1 = decodable.init(method: "GET", URLString: "https://api.example.invalid/v1/materials", parameters: nil, requiresAuthentication: true, apiConfiguration: config)
        let b2 = plain.init(method: "POST", URLString: "https://api.example.invalid/v1/auth/logout", parameters: nil, requiresAuthentication: true, apiConfiguration: config)
        XCTAssertTrue((b1 as? URLSessionRequestBuilder<MaterialPage>)?.createURLSession() as? URLSession === NoCacheAPISession.shared)
        XCTAssertTrue((b2 as? URLSessionRequestBuilder<Void>)?.createURLSession() as? URLSession === NoCacheAPISession.shared)
    }
}
