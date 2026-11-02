import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import UploadCore

/// الجلسة الخلفية لا تقبل `data(for:)` (يرمي استثناءً يُنهي التطبيق): أول رفع حقيقي من TestFlight انهار عند POST إنشاء
/// الرفع بعد رمز البوابة مباشرة. طلبات التحكم تذهب إلى جلسة عابرة، وأجزاء PATCH وحدها إلى الخلفية.
final class ControlSessionTests: XCTestCase {
    #if canImport(Darwin)
    func testBackgroundTransportSendsControlRequestsThroughAForegroundSession() {
        let config = URLSessionConfiguration.background(withIdentifier: "test.control-session.\(UUID().uuidString)")
        config.waitsForConnectivity = true
        let transport = URLSessionTusTransport(configuration: config)
        let control = transport.controlSession.configuration
        XCTAssertNil(control.identifier, "طلبات التحكم يجب ألا تمر بالجلسة الخلفية")
        XCTAssertNil(control.urlCache)
        XCTAssertNil(control.httpCookieStorage)
        XCTAssertTrue(control.waitsForConnectivity)
    }
    #endif

    func testForegroundTransportReusesItsOwnSession() {
        let transport = URLSessionTusTransport(configuration: .ephemeral)
        XCTAssertNil(transport.controlSession.configuration.identifier)
    }

    func testControlConfigurationCopiesTimeoutAndWaiting() {
        let source = URLSessionConfiguration.default
        source.timeoutIntervalForRequest = 42
        #if canImport(Darwin)
        source.waitsForConnectivity = true
        #endif
        let c = URLSessionTusTransport.controlConfiguration(from: source)
        XCTAssertEqual(c.timeoutIntervalForRequest, 42)
        #if canImport(Darwin)
        XCTAssertTrue(c.waitsForConnectivity)
        #endif
        XCTAssertNil(c.identifier)
    }
}
