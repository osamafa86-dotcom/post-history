import Foundation
import PostHistoryAPI

/// قارئ حالات `tools/acceptance/form-conformance/cases.json` ومنتج ملف نتيجة المنصة `{platform: "ios", results}`.
public enum ConformanceSuite {
    public struct Case: Decodable {
        public var id: String
        public var form: String
        public var materialType: String
        public var values: [String: FormValue]
        public var expect: ValidationResult
        enum CodingKeys: String, CodingKey { case id, form, materialType = "material_type", values, expect }
    }

    public struct Suite: Decodable {
        public var forms: [String: String]
        public var cases: [Case]
    }

    public struct Output: Encodable {
        public var platform = "ios"
        public var results: [String: ValidationResult]
    }

    public static func load(casesFile: URL) throws -> (Suite, [String: UploadForm]) {
        let suite = try JSONDecoder().decode(Suite.self, from: Data(contentsOf: casesFile))
        let decoder = CodableHelper().jsonDecoder
        let base = casesFile.deletingLastPathComponent()
        let forms = try suite.forms.mapValues { try decoder.decode(UploadForm.self, from: Data(contentsOf: base.appendingPathComponent($0))) }
        return (suite, forms)
    }

    public static func run(casesFile: URL) throws -> (Output, mismatches: [String]) {
        let (suite, forms) = try load(casesFile: casesFile)
        var results: [String: ValidationResult] = [:]
        var mismatches: [String] = []
        for c in suite.cases {
            guard let form = forms[c.form] else { throw NSError(domain: "ConformanceSuite", code: 1, userInfo: [NSLocalizedDescriptionKey: "form \(c.form) missing"]) }
            let got = FormValidator.validate(form: form, materialType: c.materialType, values: c.values)
            results[c.id] = got
            if got != c.expect { mismatches.append("\(c.id): expected \(c.expect) got \(got)") }
        }
        return (Output(results: results), mismatches)
    }
}
