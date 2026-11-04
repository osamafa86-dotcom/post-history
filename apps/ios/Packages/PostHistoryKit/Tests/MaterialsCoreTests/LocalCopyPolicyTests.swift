import XCTest
import PostHistoryAPI
import UploadCore
@testable import MaterialsCore

/// حذف النسخة المحلية بعد التحقق وحده (الخطة: «وصل الأصل وتم التحقق منه»؛ ADR 0088): قاعدة واحدة لإيصال الإرسالة،
/// وإيصال المادة الواحدة، و«عرض الإيصال» في «موادي».
final class LocalCopyPolicyTests: XCTestCase {
    private func record(_ phase: UploadPhase, material: UUID = UUID(), kind: UploadSessionCreate.Kind = .original,
                        at seconds: TimeInterval = 0) -> UploadRecord {
        var rec = UploadRecord(materialId: material, kind: kind, sourcePath: "Uploads/\(UUID().uuidString).mov", filename: "a.mov",
                               mimeType: "video/quicktime", sizeBytes: 10, now: Date(timeIntervalSince1970: seconds))
        rec.phase = phase
        return rec
    }

    /// كل حالات الرفع، والفاشل بكل أسبابه.
    private var unverified: [UploadPhase] {
        let failures = UploadFailure.allCases
        return [.hashing, .creatingSession, .creatingUpload, .transferring, .completing, .awaitingReceipt, .cancelled] + failures.map { .failed($0) }
    }

    func testOnlyAVerifiedOrMatchedOriginalMayLoseItsLocalCopy() {
        for phase in unverified {
            XCTAssertFalse(LocalCopyPolicy.mayDelete(phase), "\(phase)")
            XCTAssertFalse(LocalCopyPolicy.mayDelete(record: record(phase)), "\(phase)")
        }
        for phase: UploadPhase in [.verified(receiptNumber: "PH-1"), .deduplicated(duplicateOfFileId: UUID()), .deduplicated(duplicateOfFileId: nil)] {
            XCTAssertTrue(LocalCopyPolicy.mayDelete(phase), "\(phase)")
            XCTAssertTrue(LocalCopyPolicy.mayDelete(record: record(phase)), "\(phase)")
        }
    }

    func testTheSingleItemReceiptRefusesAnUnverifiedRecord() {
        // بايتات وصلت ولم تُطابق بصمتها بعد (`original_received` على الخادم): لا خيار حذف، بل سطر أن الحذف بعد التحقق.
        for phase: UploadPhase in [.completing, .awaitingReceipt, .transferring] {
            let rec = record(phase)
            let choice = LocalCopyPolicy.receiptChoice(scope: [rec]) { _ in true }
            XCTAssertEqual(choice.deletable, [], "\(phase)")
            XCTAssertEqual(choice.awaitingVerification, [rec], "\(phase)")
        }
        // فاشل أو ملغى: لا حذف ولا وعد بتحقق لن يأتي.
        for phase: UploadPhase in [.failed(.checksumMismatch), .cancelled] {
            let choice = LocalCopyPolicy.receiptChoice(scope: [record(phase)]) { _ in true }
            XCTAssertEqual(choice, LocalCopyPolicy.ReceiptChoice(deletable: [], awaitingVerification: []), "\(phase)")
        }
        let verified = record(.verified(receiptNumber: "PH-2"))
        XCTAssertEqual(LocalCopyPolicy.receiptChoice(scope: [verified]) { _ in true }.deletable, [verified])
        XCTAssertEqual(LocalCopyPolicy.receiptChoice(scope: [verified]) { _ in false }.deletable, [], "no copy left, nothing to offer")
    }

    func testTheSendReceiptOffersOnlyWhatWasVerifiedOrMatched() {
        let verified = record(.verified(receiptNumber: "PH-3"))
        let matched = record(.deduplicated(duplicateOfFileId: UUID()))
        let pending = record(.awaitingReceipt)
        let failed = record(.failed(.expired))
        let handled = record(.verified(receiptNumber: "PH-4"))
        let choice = LocalCopyPolicy.receiptChoice(scope: [verified, matched, pending, failed, handled]) { $0.id != handled.id }
        XCTAssertEqual(choice.deletable, [verified, matched])
        XCTAssertEqual(choice.awaitingVerification, [pending])
    }

    func testMyMaterialsOpensTheReceiptWithTheVerifiedRecord() {
        let m = UUID()
        let olderVerified = record(.verified(receiptNumber: "PH-5"), material: m, at: 1)
        let newerPending = record(.awaitingReceipt, material: m, at: 2)
        let failed = record(.failed(.sourceMissing), material: m, at: 3)
        let proxy = record(.verified(receiptNumber: "PH-6"), material: m, kind: .proxy, at: 4)
        let otherMaterial = record(.verified(receiptNumber: "PH-7"), at: 5)
        let all = [newerPending, failed, proxy, otherMaterial, olderVerified]
        XCTAssertEqual(LocalCopyPolicy.receiptRecord(forMaterial: m, in: all), olderVerified,
                       "the verified original, not the first or newest record of the material")

        // لا أصل متحقَّق: سجل في طريقه إلى التحقق، والإيصال لا يعرض معه حذفًا.
        let pendingOnly = LocalCopyPolicy.receiptRecord(forMaterial: m, in: [failed, newerPending, proxy])
        XCTAssertEqual(pendingOnly, newerPending)
        XCTAssertEqual(LocalCopyPolicy.receiptChoice(scope: pendingOnly.map { [$0] } ?? []) { _ in true }.deletable, [])

        XCTAssertNil(LocalCopyPolicy.receiptRecord(forMaterial: m, in: [failed, proxy, otherMaterial]), "no record: no delete offered at all")
    }
}
