import XCTest
import PostHistoryAPI
@testable import MaterialsCore

/// لا مفتاح خام على الشاشة (بناء 1.0 (11)): كان `Text(LocalizedStringKey("gallery.quick.\(x)"))` يصير مفتاح صيغة "gallery.quick.%@"
/// لا وجود له، فظهرت `gallery.quick.all` و`material.type.report` و`detail.track.technical` كما هي. يعمل الاختباران في وظيفتي iOS في CI
/// (Linux وmacOS)، فلا يُدمج الخطأ نفسه مرة أخرى.
final class TextKeysTests: XCTestCase {
    private var appDirectory: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../App").standardized
    }

    func testEveryKeyBuiltFromAnEnumIsInTheCatalogInArabicAndEnglish() throws {
        let catalog = appDirectory.appendingPathComponent("Resources/Localizable.xcstrings")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as! [String: Any]
        let strings = json["strings"] as! [String: Any]
        XCTAssertFalse(TextKeys.all.isEmpty)
        for key in TextKeys.all {
            let loc = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
            XCTAssertNotNil(loc?["ar"], "missing ar for \(key)")
            XCTAssertNotNil(loc?["en"], "missing en for \(key)")
        }
        XCTAssertEqual(GalleryQuickFilter.all.textKey, "gallery.quick.all")
        XCTAssertEqual(MaterialType.rawFootage.textKey, "material.type.raw_footage")
        XCTAssertEqual(MaterialType.unknownDefaultOpenApi.textKey, "material.type.unknown")
        XCTAssertEqual(MaterialStatus.Track.technical.detailKey, "detail.track.technical")
    }

    /// (أ) حرفي فيه `\(` داخل `LocalizedStringKey(` يُرفض أيًّا كان؛ وحرفي يبدأ بمفتاح منقوط وينتهي بنقطة ثم `\(` (يكمل مفتاحًا لا وسيطًا)
    /// يُرفض في `Text(` و`Label(` و`Button(` و`LocalizedStringResource(` و`String(localized:`. المفتاح يُبنى `String` ثم `Text(key:)`.
    func testNoInterpolatedLiteralCompletesALocalizationKey() throws {
        let sources = appDirectory.appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertFalse(files.isEmpty, "the app sources are next to the package")
        let anyInterpolation = try NSRegularExpression(pattern: #"LocalizedStringKey\(\s*"(?:[^"\\]|\\.)*\\\("#)
        let keyPrefix = try NSRegularExpression(
            pattern: #"(?:Text|Label|Button|LocalizedStringResource|localized:)\s*\(?\s*"[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\.\\\("#)
        var offenders: [String] = []
        for file in files {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() {
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { continue }
                let range = NSRange(line.startIndex..., in: line)
                if anyInterpolation.firstMatch(in: line, range: range) != nil || keyPrefix.firstMatch(in: line, range: range) != nil {
                    offenders.append("\(file.lastPathComponent):\(index + 1)")
                }
            }
        }
        XCTAssertEqual(offenders, [], "build the key as a String (`textKey`) and use `Text(key:)`")
    }

    /// الفحص نفسه يلتقط الصيغ التي أظهرت المفاتيح الخام (لا يمر عليها ما كان في بناء 11).
    func testTheGuardCatchesTheShapesThatShippedInBuild11() throws {
        let anyInterpolation = try NSRegularExpression(pattern: #"LocalizedStringKey\(\s*"(?:[^"\\]|\\.)*\\\("#)
        let keyPrefix = try NSRegularExpression(
            pattern: #"(?:Text|Label|Button|LocalizedStringResource|localized:)\s*\(?\s*"[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\.\\\("#)
        func caught(_ line: String) -> Bool {
            let range = NSRange(line.startIndex..., in: line)
            return anyInterpolation.firstMatch(in: line, range: range) != nil || keyPrefix.firstMatch(in: line, range: range) != nil
        }
        XCTAssertTrue(caught(#"label: Text(LocalizedStringKey("gallery.quick.\(quick.rawValue)")))"#))
        XCTAssertTrue(caught(#"Text("detail.track.\(track.rawValue)")"#))
        XCTAssertTrue(caught(#"String(localized: "material.type.\(t)")"#))
        XCTAssertFalse(caught(#"Text("gallery.section.count \(section.materials.count)")"#), "an interpolated argument is fine")
        XCTAssertFalse(caught(#"Text(key: quick.textKey)"#))
        XCTAssertFalse(caught(#"static func anchor(_ key: String) -> String { "form.field.\(key)" }"#), "a plain String is fine")
    }
}
