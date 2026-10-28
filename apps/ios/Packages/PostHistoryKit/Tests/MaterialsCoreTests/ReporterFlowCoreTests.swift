import XCTest
import FormEngine
import PostHistoryAPI
@testable import MaterialsCore

/// منطق تدفق المراسل بلا واجهة (المواصفة A1–A4): المسودة وتحققها، والخط الزمني، وصياغة الإيصال.
final class ReporterFlowCoreTests: XCTestCase {
    private func complete() -> MaterialDraft {
        var d = MaterialDraft()
        d.files = [.init(relativePath: "Uploads/a.mov", filename: "a.mov", sizeBytes: 10, mimeType: "video/quicktime", isVideo: true, durationSeconds: 60)]
        d.title = "قصف على حي"
        d.materialTypes = [.report]
        d.governorate = "غزة"; d.city = "غزة"
        d.priority = .urgent
        d.minors = false; d.injured = true; d.graphic = false
        d.displayMode = .network
        d.formVersion = 3
        return d
    }

    func testSensitivityHasNoDefaultAndMustBeAnswered() {
        var d = complete()
        d.injured = nil
        XCTAssertNil(d.sensitivity)
        XCTAssertTrue(DraftValidator.fieldIssues(d).contains(.sensitivityUnanswered))
        XCTAssertNil(DraftValidator.materialCreate(d, dynamicFields: [:]))
        XCTAssertTrue(DraftValidator.fieldIssues(MaterialDraft()).contains(.sensitivityUnanswered), "a new draft starts unanswered")
    }

    func testTitleIsCountedInCodePoints() {
        XCTAssertEqual(DraftValidator.titleLength("👨‍👩‍👧"), 5, "a family emoji is five code points")
        var d = complete()
        d.title = "abcd"
        XCTAssertTrue(DraftValidator.fieldIssues(d).contains(.titleLength))
        d.title = String(repeating: "م", count: 81)
        XCTAssertTrue(DraftValidator.fieldIssues(d).contains(.titleLength))
        d.title = String(repeating: "م", count: 80)
        XCTAssertFalse(DraftValidator.fieldIssues(d).contains(.titleLength))
    }

    func testCompleteDraftBuildsTheContractBody() throws {
        var d = complete()
        XCTAssertEqual(DraftValidator.fieldIssues(d), [])
        let body = try XCTUnwrap(DraftValidator.materialCreate(d, dynamicFields: ["k": .string("v")]))
        XCTAssertEqual(body.sensitivity, Sensitivity(minors: false, injured: true, graphic: false))
        XCTAssertNil(body.gps, "no coordinates from the reporter app by default")
        XCTAssertEqual(body.formVersion, 3)
        d.displayMode = .pseudonym
        XCTAssertEqual(DraftValidator.fieldIssues(d), [.pseudonymMissing])
        d.materialTypes = []
        XCTAssertTrue(DraftValidator.fieldIssues(d).contains(.typeMissing))
    }

    func testDraftsPersistWithAStableIdempotencyKeyAndCanBeDeleted() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("drafts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try FileDraftStore(directory: dir)
        var d = complete()
        d.dynamicValues = ["k": .string("v")]
        try store.save(d)
        let loaded = try XCTUnwrap(store.loadAll().first)
        XCTAssertEqual(loaded, d)
        XCTAssertEqual(loaded.createIdempotencyKey, "material-create-\(d.id.uuidString.lowercased())")
        d.title = "عنوان آخر للمادة"
        try store.save(d)
        XCTAssertEqual(store.loadAll().count, 1, "saving again replaces the draft")
        XCTAssertEqual(store.loadAll().first?.createIdempotencyKey, loaded.createIdempotencyKey, "the key does not change")
        store.delete(d.id)
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    private func record(_ track: TransitionRecord.Track, _ to: String, _ reason: String = "", at seconds: TimeInterval) -> TransitionRecord {
        TransitionRecord(id: UUID().uuidString, track: track, from: "x", to: to, reason: reason, actorId: nil, occurredAt: Date(timeIntervalSince1970: seconds))
    }

    func testTimelineKeepsTracksSeparateNewestFirstAndFilters() {
        let t = MaterialTimeline([
            record(.technical, "proxy_received", at: 1), record(.editorial, "acknowledged", at: 2),
            record(.rights, "documented", at: 3), record(.technical, "verified", at: 4),
        ])
        XCTAssertEqual(t.events.map(\.occurredAt.timeIntervalSince1970), [4, 3, 2, 1])
        XCTAssertEqual(t.filtered(.technical).map(\.to), ["verified", "proxy_received"])
        XCTAssertEqual(t.filtered(nil).count, 4)
        XCTAssertEqual(MaterialTimeline.labelKey(t.events[0]), "material.technical.verified")
        XCTAssertEqual(MaterialTimeline.labelKey(t.events[1]), "material.rights.documented")
    }

    func testSupervisorNoteOnlyWhileChangesAreRequested() {
        let t = MaterialTimeline([record(.editorial, "needs_changes", "اللقطة الثانية مهزوزة", at: 5), record(.editorial, "acknowledged", at: 2)])
        XCTAssertEqual(t.supervisorNote(for: material(editorial: .needsChanges))?.reason, "اللقطة الثانية مهزوزة")
        XCTAssertNil(t.supervisorNote(for: material(editorial: .reviewing)))
    }

    func testNeedsActionAndPrimaryAction() {
        XCTAssertTrue(material(editorial: .needsChanges).needsAction)
        XCTAssertTrue(material(technical: .failed).needsAction)
        XCTAssertFalse(material().needsAction)
        XCTAssertEqual(material(editorial: .needsChanges).primaryAction, .replaceShot)
        XCTAssertEqual(material(technical: .verified).primaryAction, .showReceipt)
        XCTAssertEqual(material(editorial: .published).primaryAction, .none)
    }

    func testReceiptShortHashAndLinkCarryNothingButTheIdentifiers() {
        let sha = String(repeating: "a", count: 28) + "0123456789abcdef0123456789ab"
        XCTAssertEqual(ReceiptFormatting.shortHash(sha), "aaaaaaaa…456789ab")
        let id = UUID()
        XCTAssertEqual(ReceiptFormatting.internalLink(materialId: id), "posthistory://materials/\(id.uuidString.lowercased())")
    }

    func testEveryDraftIssueHasArabicAndEnglishText() throws {
        let catalog = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../App/Resources/Localizable.xcstrings").standardized
        let strings = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as? [String: Any])["strings"] as? [String: Any]
        for issue in DraftValidator.Issue.allCases {
            let entry = try XCTUnwrap(strings?[issue.labelKey] as? [String: Any], issue.labelKey)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any])
            XCTAssertNotNil(localizations["ar"], issue.labelKey)
            XCTAssertNotNil(localizations["en"], issue.labelKey)
        }
    }
}
