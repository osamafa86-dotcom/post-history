import XCTest
import FormEngine
import PostHistoryAPI
@testable import MaterialsCore

/// عدة ملفات في المادة الواحدة: ترحيل المسودات القديمة (ملف واحد)، والتحقق، وحقائق المجموعة، وما يعدّ إدخالًا يضيع بالإغلاق.
final class MultiFileDraftTests: XCTestCase {
    private func file(_ name: String, size: Int64 = 10, video: Bool = true, duration: Double? = 60) -> MaterialDraft.PickedFile {
        .init(relativePath: "Uploads/\(name)", filename: name, sizeBytes: size, mimeType: video ? "video/quicktime" : "image/jpeg", isVideo: video, durationSeconds: duration)
    }

    private func complete(files: [MaterialDraft.PickedFile]) -> MaterialDraft {
        var d = MaterialDraft()
        d.files = files
        d.title = "قصف على حي"
        d.materialTypes = [.report]
        d.governorate = "غزة"; d.city = "غزة"
        d.priority = .urgent
        d.minors = false; d.injured = true; d.graphic = false
        d.displayMode = .network
        d.formVersion = 3
        return d
    }

    /// يحاكي ملف مسودة كتبه إصدار سابق: مفتاح `file` بدل `files`.
    private func legacyJSON(from draft: MaterialDraft, file: MaterialDraft.PickedFile?) throws -> Data {
        let encoder = JSONEncoder()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(draft)) as? [String: Any])
        object["files"] = nil
        if let file {
            let encoded: Any = try JSONSerialization.jsonObject(with: encoder.encode(file))
            object["file"] = encoded
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    func testLegacySingleFileDraftDecodesToOneElementArray() throws {
        let old = file("a.mov", size: 99, duration: 12)
        let source = complete(files: [old])
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: legacyJSON(from: source, file: old))
        XCTAssertEqual(decoded.files, [old])
        XCTAssertEqual(decoded.id, source.id)
        XCTAssertEqual(decoded.title, source.title)
        XCTAssertEqual(decoded.createIdempotencyKey, source.createIdempotencyKey, "the create key survives the migration")
        XCTAssertEqual(decoded.sensitivity, source.sensitivity)
    }

    func testLegacyDraftWithoutAFileDecodesToEmpty() throws {
        let source = complete(files: [])
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: legacyJSON(from: source, file: nil))
        XCTAssertTrue(decoded.files.isEmpty)
        XCTAssertEqual(DraftValidator.fileIssues(decoded), [.fileMissing])
    }

    func testFilesRoundTripInOrderAndNeverWriteTheOldKey() throws {
        let draft = complete(files: [file("b.mov"), file("a.jpg", video: false, duration: nil), file("c.mov")])
        let data = try JSONEncoder().encode(draft)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["file"])
        XCTAssertEqual((object["files"] as? [Any])?.count, 3)
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: data)
        XCTAssertEqual(decoded, draft)
        XCTAssertEqual(decoded.files.map(\.filename), ["b.mov", "a.jpg", "c.mov"])
    }

    func testStoreReadsALegacyDraftFileOnDisk() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("drafts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try FileDraftStore(directory: dir)
        let old = file("a.mov")
        let source = complete(files: [old])
        try legacyJSON(from: source, file: old).write(to: dir.appendingPathComponent("\(source.id.uuidString.lowercased()).json"))
        XCTAssertEqual(store.loadAll().first?.files, [old])
    }

    func testValidatorNeedsAtLeastOneFile() {
        var d = complete(files: [])
        XCTAssertEqual(DraftValidator.fileIssues(d), [.fileMissing])
        XCTAssertNil(DraftValidator.materialCreate(d, dynamicFields: [:]))
        d.files = [file("a.mov")]
        XCTAssertEqual(DraftValidator.fileIssues(d), [])
        XCTAssertNotNil(DraftValidator.materialCreate(d, dynamicFields: [:]))
        d.files.append(file("b.mov"))
        XCTAssertEqual(DraftValidator.fileIssues(d), [])
        XCTAssertNotNil(DraftValidator.materialCreate(d, dynamicFields: [:]), "several files are still one material body")
    }

    func testSetFactsUseAllFilesAndTheLongestVideo() {
        var d = MaterialDraft()
        XCTAssertEqual(d.totalSizeBytes, 0)
        XCTAssertNil(d.longestVideoSeconds)
        d.files = [file("a.jpg", size: 5, video: false, duration: nil), file("b.mov", size: 100, duration: 20), file("c.mov", size: 400, duration: 95.5)]
        XCTAssertEqual(d.totalSizeBytes, 505)
        XCTAssertEqual(d.videoCount, 2)
        XCTAssertEqual(d.longestVideoSeconds, 95.5)
        d.files = [file("a.jpg", video: false, duration: nil)]
        XCTAssertNil(d.longestVideoSeconds, "photos alone give no light-copy suggestion")
    }

    func testHasInputCoversFilesAndEveryTypedField() {
        XCTAssertFalse(MaterialDraft().hasInput)
        var d = MaterialDraft(); d.files = [file("a.mov")]
        XCTAssertTrue(d.hasInput)
        d = MaterialDraft(); d.title = "  \n"
        XCTAssertFalse(d.hasInput, "whitespace is not input")
        d.title = "عنوان"
        XCTAssertTrue(d.hasInput)
        d = MaterialDraft(); d.city = "غزة"
        XCTAssertTrue(d.hasInput)
        d = MaterialDraft(); d.injured = false
        XCTAssertTrue(d.hasInput, "an answered sensitivity question counts")
        d = MaterialDraft(); d.materialTypes = [.report]
        XCTAssertTrue(d.hasInput)
        d = MaterialDraft(); d.dynamicValues = ["k": .string("v")]
        XCTAssertTrue(d.hasInput)
    }

    func testTheLimitIsTwentyFiles() {
        XCTAssertEqual(MaterialDraft.maxFiles, 20)
    }
}
