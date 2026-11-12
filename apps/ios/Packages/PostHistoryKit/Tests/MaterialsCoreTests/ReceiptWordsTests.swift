import XCTest

/// نص الإيصال يقول ما حدث فعلًا: وصلت المادة إلى المكتبة وحُفظت. لا يدّعي أن المحرّرين استلموها؛ «استلام» ومشتقاتها لفعل المحرّر وحده.
/// النص في كتالوج التطبيق، فيعمل الاختبار في وظيفتي iOS في CI (Linux وmacOS).
final class ReceiptWordsTests: XCTestCase {
    private func strings() throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../App/Resources/Localizable.xcstrings").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        return try XCTUnwrap(json?["strings"] as? [String: Any])
    }

    private func value(_ key: String, _ language: String, in strings: [String: Any]) -> String? {
        let localizations = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
        let unit = (localizations?[language] as? [String: Any])?["stringUnit"] as? [String: Any]
        return unit?["value"] as? String
    }

    func testTheReceiptSaysTheMaterialArrivedAndDoesNotClaimAnEditorReceivedIt() throws {
        let catalog = try strings()
        for key in ["receipt.v2.body %@ %@", "receipt.v2.bodyOne %@"] {
            let arabic = try XCTUnwrap(value(key, "ar", in: catalog), key)
            let english = try XCTUnwrap(value(key, "en", in: catalog), key).lowercased()
            XCTAssertFalse(arabic.contains("استلم"), "\(key) claims an editor received it")
            XCTAssertFalse(english.contains("received"), "\(key) claims an editor received it")
            XCTAssertTrue(arabic.hasPrefix("وصلت"), key)
            XCTAssertTrue(arabic.contains("إلى المكتبة وحُفظت"), key)
            XCTAssertTrue(english.contains("reached the library"), key)
        }
    }

    func testTheReceiptKeepsItsPlaceholders() throws {
        let catalog = try strings()
        for language in ["ar", "en"] {
            let many = try XCTUnwrap(value("receipt.v2.body %@ %@", language, in: catalog))
            XCTAssertTrue(many.contains("%1$@") && many.contains("%2$@"), "the count and the title [\(language)]")
            let one = try XCTUnwrap(value("receipt.v2.bodyOne %@", language, in: catalog))
            XCTAssertEqual(one.components(separatedBy: "%@").count, 2, "the title once [\(language)]")
        }
    }
}
