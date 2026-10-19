import XCTest
import PostHistoryAPI
@testable import FormEngine

final class FormConformanceTests: XCTestCase {
    /// الحَكَم هو cases.json المشترك في tools/acceptance؛ يُقرأ من المستودع كما هو دون نسخه.
    static var casesFile: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../../tools/acceptance/form-conformance/cases.json").standardized
    }

    func testEverySharedCaseMatchesExpectation() throws {
        let (output, mismatches) = try ConformanceSuite.run(casesFile: Self.casesFile)
        XCTAssertGreaterThanOrEqual(output.results.count, 57)
        XCTAssertEqual(mismatches, [])
    }

    func testCodePointsNotUTF16OrGraphemes() {
        let field = UploadFormField(key: "h", type: .shortText, label: UploadFormLocalized(ar: "ع", en: "H"), required: true, validation: UploadFormValidation(minLength: 2, maxLength: 2))
        XCTAssertNil(FormValidator.check(field, .string("😀😀")), "emoji outside the BMP count as one each")
        XCTAssertEqual(FormValidator.check(field, .string("😀")), .minLength)
        XCTAssertEqual(FormValidator.check(field, .string("بَّ")), .maxLength, "each combining mark counts as one")
    }

    func testFormValueRoundTripsThroughJSON() throws {
        let value: FormValue = .object(["a": .array([.number(1), .string("x"), .bool(false), .null]), "b": .number(1.5)])
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(FormValue.self, from: data), value)
        XCTAssertEqual(FormValue(JSONValue.int(5)), .number(5))
        XCTAssertEqual(FormValue.number(5).jsonValue, .int(5))
    }
}
