import XCTest
import UploadCore
@testable import MaterialsCore

/// إعلان تغيّر حالة الرفع لقارئ الشاشة، ونصوص فشل الرفع بكلمات المراسل. المنطق هنا والنصوص في كتالوج التطبيق، فيعمل الاختبار في
/// وظيفتي iOS في CI (Linux وmacOS).
final class UploadAnnouncementTests: XCTestCase {
    private let material = UUID()

    private func item(_ id: UUID, _ state: UploadItem.State, paused: Bool = false, offset: Int64 = 0) -> UploadItem {
        UploadItem(id: id, materialId: material, sizeBytes: 100, confirmedOffset: offset, state: state, paused: paused)
    }

    private func catalog() throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../App/Resources/Localizable.xcstrings").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        return try XCTUnwrap(json?["strings"] as? [String: Any])
    }

    private func text(_ key: String, _ language: String, in strings: [String: Any]) -> String? {
        let localizations = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
        let unit = (localizations?[language] as? [String: Any])?["stringUnit"] as? [String: Any]
        return unit?["value"] as? String
    }

    func testATransitionToFailedPausedOrArrivedIsAnnounced() {
        let a = UUID(), b = UUID(), c = UUID()
        let before = [item(a, .transferring), item(b, .transferring), item(c, .finishing)]
        let after = [item(a, .transferring, paused: true), item(b, .failed), item(c, .arrived)]
        XCTAssertEqual(UploadAnnouncement.changes(from: before, to: after), [.failed, .paused, .arrived])
        XCTAssertEqual(UploadAnnouncement.changes(from: after, to: after), [], "a state that stays is not announced again")
    }

    func testProgressAloneIsNeverAnnounced() {
        let a = UUID()
        var snapshot = [item(a, .preparing)]
        let steps: [(UploadItem.State, Int64)] = [(.transferring, 10), (.transferring, 50), (.transferring, 99), (.finishing, 100)]
        for (state, offset) in steps {
            let next = [item(a, state, offset: offset)]
            XCTAssertEqual(UploadAnnouncement.changes(from: snapshot, to: next), [])
            snapshot = next
        }
        XCTAssertEqual(UploadAnnouncement.changes(from: snapshot, to: [item(a, .arrived, offset: 100)]), [.arrived])
    }

    func testAFileSeenForTheFirstTimeIsNotAnnounced() {
        let old = UUID(), fresh = UUID()
        XCTAssertEqual(UploadAnnouncement.changes(from: [], to: [item(old, .failed), item(fresh, .arrived)]), [])
        XCTAssertEqual(UploadAnnouncement.changes(from: [item(old, .failed)], to: [item(old, .failed), item(fresh, .transferring, paused: true)]), [])
    }

    func testSeveralFilesChangingTogetherMakeOneAnnouncementPerKind() {
        let ids = (0..<4).map { _ in UUID() }
        let before = ids.map { item($0, .transferring) }
        let after = [item(ids[0], .failed), item(ids[1], .failed), item(ids[2], .arrived), item(ids[3], .arrived)]
        XCTAssertEqual(UploadAnnouncement.changes(from: before, to: after), [.failed, .arrived])
    }

    func testPausingAgainAfterResumingIsAnnouncedAgainAndCancellingIsNot() {
        let a = UUID()
        let moving = [item(a, .transferring)], paused = [item(a, .transferring, paused: true)]
        XCTAssertEqual(UploadAnnouncement.changes(from: moving, to: paused), [.paused])
        XCTAssertEqual(UploadAnnouncement.changes(from: paused, to: moving), [])
        XCTAssertEqual(UploadAnnouncement.changes(from: moving, to: paused), [.paused])
        XCTAssertEqual(UploadAnnouncement.changes(from: paused, to: [item(a, .cancelled, paused: true)]), [])
        XCTAssertEqual(UploadAnnouncement.changes(from: paused, to: [item(a, .failed, paused: true)]), [.failed], "a failure is said even when the file was paused")
    }

    func testEveryAnnouncementHasItsWordsInBothLanguagesAndNamesNothing() throws {
        let strings = try catalog()
        for announcement in UploadAnnouncement.allCases {
            for language in ["ar", "en"] {
                let value = try XCTUnwrap(text(announcement.textKey, language, in: strings), "\(announcement.textKey) [\(language)]")
                XCTAssertFalse(value.isEmpty)
                XCTAssertFalse(value.contains("%"), "an announcement carries no title, file name or receipt number")
            }
        }
    }

    /// سبب الفشل بكلمات المراسل: ما حدث ثم الخطوة، بلا «خادم» ولا «بصمة» ولا «جلسة». «الحساب لا يرفع» جملة واحدة كما كانت.
    func testAFailureIsSaidInTheReportersWordsNotTheServers() throws {
        let strings = try catalog()
        for failure in UploadFailure.allCases {
            let arabic = try XCTUnwrap(text(failure.textKey, "ar", in: strings), failure.textKey)
            let english = try XCTUnwrap(text(failure.textKey, "en", in: strings), failure.textKey).lowercased()
            for word in ["خادم", "بصمة", "جلسة"] { XCTAssertFalse(arabic.contains(word), "\(failure.textKey) says «\(word)»") }
            for word in ["server", "fingerprint", "session"] { XCTAssertFalse(english.contains(word), "\(failure.textKey) says \(word)") }
            if failure != .notPermitted {
                XCTAssertGreaterThanOrEqual(arabic.filter { $0 == "." }.count, 2, "\(failure.textKey): what happened, then the step")
                XCTAssertGreaterThanOrEqual(english.filter { $0 == "." }.count, 2, "\(failure.textKey): what happened, then the step")
            }
        }
    }
}
