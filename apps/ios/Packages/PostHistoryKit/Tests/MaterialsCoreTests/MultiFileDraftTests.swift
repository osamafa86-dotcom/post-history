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
        XCTAssertEqual(decoded.files.count, 1)
        XCTAssertEqual(decoded.files[0].relativePath, old.relativePath)
        XCTAssertEqual(decoded.files[0].filename, old.filename)
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
        XCTAssertEqual(store.loadAll().first?.files.map(\.filename), [old.filename])
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

    // MARK: مادة لكل ملف

    func testEachFileHasItsOwnKeyAndItSurvivesEncodeDecode() throws {
        var draft = complete(files: [file("a.mov"), file("b.mov"), file("c.jpg", video: false, duration: nil)])
        draft.files[1].createdMaterialId = UUID()
        let keys = draft.files.map(\.createIdempotencyKey)
        XCTAssertEqual(Set(keys).count, 3, "one key per file")
        XCTAssertTrue(keys.allSatisfy { $0.hasPrefix("material-create-") })
        let again = try JSONDecoder().decode(MaterialDraft.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(again.files.map(\.createIdempotencyKey), keys, "keys are stable across a save and a load")
        XCTAssertEqual(again.files.map(\.createdMaterialId), draft.files.map(\.createdMaterialId))
        XCTAssertNotEqual(keys[0], draft.createIdempotencyKey, "the draft-level key is not reused for new drafts")
    }

    func testAFileWrittenWithoutAKeyGetsOneByDecoding() throws {
        let data = Data(#"{"relativePath":"Uploads/a.mov","filename":"a.mov","sizeBytes":3,"isVideo":true}"#.utf8)
        let decoded = try JSONDecoder().decode(MaterialDraft.PickedFile.self, from: data)
        XCTAssertTrue(decoded.createIdempotencyKey.hasPrefix("material-create-"))
        XCTAssertNil(decoded.createdMaterialId)
        XCTAssertNil(decoded.titleSuffix)
    }

    func testALegacyDraftKeepsItsDraftLevelKeyAndCreatedMaterialForItsFile() throws {
        let old = file("a.mov")
        var source = complete(files: [old])
        source.createdMaterialId = UUID()
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: legacyJSON(from: source, file: old))
        XCTAssertEqual(decoded.files[0].createIdempotencyKey, source.createIdempotencyKey, "a retry stays idempotent")
        XCTAssertEqual(decoded.files[0].createdMaterialId, source.createdMaterialId, "an already created material is not created again")
    }

    func testTheSuffixIsEmptyForOneFileAndAsciiLtrForMany() {
        XCTAssertEqual(DraftValidator.titleSuffix(position: 1, of: 1), "")
        XCTAssertEqual(DraftValidator.titleSuffix(position: 3, of: 12), " \u{2066}(3/12)\u{2069}")
        var d = complete(files: [file("a.mov")])
        XCTAssertEqual(d.materialTitle(at: 0), "قصف على حي", "a single file has no suffix")
        d.files.append(file("b.mov"))
        XCTAssertEqual(d.materialTitle(at: 1), "قصف على حي \u{2066}(2/2)\u{2069}")
    }

    func testTheBaseTitleMustLeaveRoomForTheLongestSuffix() {
        // " ⁦(20/20)⁩" = 1 + 1 + 7 + 1 = 10 نقطة ترميز
        XCTAssertEqual(DraftValidator.longestSuffixLength(forFileCount: 20), 10)
        XCTAssertEqual(DraftValidator.longestSuffixLength(forFileCount: 9), 8)
        XCTAssertEqual(DraftValidator.longestSuffixLength(forFileCount: 1), 0)
        XCTAssertEqual(DraftValidator.titleLimit(forFileCount: 20), 70)
        XCTAssertEqual(DraftValidator.titleLimit(forFileCount: 1), 80)

        let many = (1...20).map { file("f\($0).mov") }
        var d = complete(files: many)
        d.title = String(repeating: "م", count: 70)
        XCTAssertEqual(DraftValidator.fieldIssues(d), [])
        d.title = String(repeating: "م", count: 71)
        XCTAssertEqual(DraftValidator.fieldIssues(d), [.titleTooLongForSet])
        XCTAssertTrue(d.materialTitle(at: 19).unicodeScalars.count > DraftValidator.titleRange.upperBound)

        d.files = [file("only.mov")]
        XCTAssertEqual(DraftValidator.fieldIssues(d), [], "one file keeps the full 80")
        d.title = String(repeating: "م", count: 81)
        XCTAssertEqual(DraftValidator.fieldIssues(d), [.titleLength], "the plain limit is still reported as before")

        d.files = [file("a.mov"), file("b.mov")]  // أطول لاحقة " ⁦(2/2)⁩" = 8
        d.title = String(repeating: "م", count: 72)
        XCTAssertEqual(DraftValidator.fieldIssues(d), [])
        d.title = String(repeating: "م", count: 73)
        XCTAssertEqual(DraftValidator.fieldIssues(d), [.titleTooLongForSet])
    }

    func testPinnedSuffixesKeepTheNumberingOfWhatRemains() {
        var d = complete(files: [file("a.mov"), file("b.mov"), file("c.mov")])
        d.pinTitleSuffixes()
        d.files.removeFirst()
        XCTAssertEqual(d.materialTitle(at: 0), "قصف على حي \u{2066}(2/3)\u{2069}", "the second file stays 2/3 after the first is gone")
        var single = complete(files: [file("a.mov")])
        single.pinTitleSuffixes()
        XCTAssertNil(single.files[0].titleSuffix, "nothing is pinned for one file")
    }

    // MARK: الإرسال

    private struct Boom: Error {}

    /// يسجّل ما أُنشئ وما أُدخل، ويفشل عند الطلب.
    @MainActor private final class Recorder {
        var created: [(key: String, title: String)] = []
        var enqueued: [(file: String, material: UUID, title: String)] = []
        var failCreateAt: Int?
        var failEnqueueAt: Int?
        var materials: [String: UUID] = [:]

        func create(_ key: String, _ body: MaterialCreate) async throws -> UUID {
            if let n = failCreateAt, created.count + 1 == n { failCreateAt = nil; throw Boom() }
            created.append((key, body.title))
            let id = UUID()
            materials[key] = id
            return id
        }

        func enqueue(_ file: MaterialDraft.PickedFile, _ material: UUID, _ body: MaterialCreate) async throws {
            if let n = failEnqueueAt, enqueued.count + 1 == n { failEnqueueAt = nil; throw Boom() }
            enqueued.append((file.filename, material, body.title))
        }
    }

    @MainActor func testSubmitCreatesOneMaterialPerFileInOrder() async throws {
        let draft = complete(files: [file("a.mov"), file("b.jpg", video: false, duration: nil), file("c.mov")])
        let r = Recorder()
        let outcome = await DraftSubmission.run(draft, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNil(outcome.error)
        XCTAssertTrue(outcome.draft.files.isEmpty)
        XCTAssertEqual(outcome.enqueuedCount, 3)
        XCTAssertEqual(r.created.map(\.key), draft.files.map(\.createIdempotencyKey))
        XCTAssertEqual(r.created.map(\.title), (1...3).map { "قصف على حي \u{2066}(\($0)/3)\u{2069}" })
        XCTAssertEqual(r.enqueued.map(\.file), ["a.mov", "b.jpg", "c.mov"])
        XCTAssertEqual(Set(r.enqueued.map(\.material)).count, 3, "each file goes to its own material")
    }

    @MainActor func testASingleFileKeepsTheBareTitle() async {
        let r = Recorder()
        let outcome = await DraftSubmission.run(complete(files: [file("a.mov")]), dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNil(outcome.error)
        XCTAssertEqual(r.created.map(\.title), ["قصف على حي"])
    }

    @MainActor func testAFailedEnqueueKeepsTheRemainingFilesAndNeverCreatesTwice() async throws {
        let draft = complete(files: [file("a.mov"), file("b.mov"), file("c.mov")])
        let keys = draft.files.map(\.createIdempotencyKey)
        let r = Recorder()
        r.failEnqueueAt = 2
        let first = await DraftSubmission.run(draft, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNotNil(first.error)
        XCTAssertEqual(first.enqueuedCount, 1)
        XCTAssertEqual(first.draft.files.map(\.filename), ["b.mov", "c.mov"], "a.mov is in the queue and gone from the draft")
        XCTAssertNotNil(first.draft.files[0].createdMaterialId, "b.mov's material exists; only its enqueue failed")
        XCTAssertNil(first.draft.files[1].createdMaterialId)
        XCTAssertEqual(r.created.count, 2)

        // الحفظ والتحميل بين المحاولتين لا يغيّران شيئًا
        let reloaded = try JSONDecoder().decode(MaterialDraft.self, from: JSONEncoder().encode(first.draft))
        let second = await DraftSubmission.run(reloaded, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNil(second.error)
        XCTAssertTrue(second.draft.files.isEmpty)
        XCTAssertEqual(r.created.map(\.key), keys, "three creates in total, each key once")
        XCTAssertEqual(r.enqueued.map(\.file), ["a.mov", "b.mov", "c.mov"], "each file enqueued exactly once")
        XCTAssertEqual(r.enqueued[1].material, r.materials[keys[1]], "b.mov goes to the material created before the failure")
        XCTAssertEqual(r.created.map(\.title), (1...3).map { "قصف على حي \u{2066}(\($0)/3)\u{2069}" }, "numbering survived the partial failure")
    }

    @MainActor func testAFailedCreateStopsTheRunAndLeavesTheRestUntouched() async {
        let draft = complete(files: [file("a.mov"), file("b.mov"), file("c.mov")])
        let r = Recorder()
        r.failCreateAt = 2
        let first = await DraftSubmission.run(draft, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNotNil(first.error)
        XCTAssertEqual(first.draft.files.map(\.filename), ["b.mov", "c.mov"])
        XCTAssertTrue(first.draft.files.allSatisfy { $0.createdMaterialId == nil })
        XCTAssertEqual(first.draft.files.map(\.createIdempotencyKey), Array(draft.files.map(\.createIdempotencyKey).dropFirst()), "the key of the failed create is reused on retry")
        let second = await DraftSubmission.run(first.draft, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertNil(second.error)
        XCTAssertEqual(r.enqueued.map(\.file), ["a.mov", "b.mov", "c.mov"])
    }

    @MainActor func testAnIncompleteDraftCreatesNothing() async {
        var draft = complete(files: [file("a.mov"), file("b.mov")])
        draft.formVersion = nil
        let r = Recorder()
        let outcome = await DraftSubmission.run(draft, dynamicFields: [:], create: r.create, enqueue: r.enqueue)
        XCTAssertEqual(outcome.error as? DraftSubmission.Failure, .incomplete)
        XCTAssertEqual(outcome.draft.files.count, 2)
        XCTAssertTrue(r.created.isEmpty)
    }
}
