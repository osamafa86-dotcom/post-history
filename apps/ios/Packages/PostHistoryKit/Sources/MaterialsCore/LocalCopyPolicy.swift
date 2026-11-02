import Foundation
import UploadCore

/// متى يجوز حذف النسخة المحلية لأصل (الخطة: الحذف بعد «وصل الأصل وتم التحقق منه»؛ ADR 0088). قاعدة واحدة يمرّ بها كل خيار حذف:
/// إيصال الإرسالة، وإيصال المادة الواحدة، و«عرض الإيصال» في «موادي».
/// - يجوز: تحقّق الخادم من البصمة وأصدر إيصالًا (`verified`)، أو طابق الأصل بأصل سابق تحقّق منه (`deduplicated`).
/// - لا يجوز ما سواهما: البايتات الواصلة بلا مطابقة البصمة (`completing` و`awaitingReceipt`، وحالة الخادم `original_received`)
///   قد يتبعها فشل، والفاشل والملغى لا أصل متحقَّقًا لهما؛ فالنسخة المحلية هي الوحيدة التي يُعاد منها الرفع.
public enum LocalCopyPolicy {
    public static func mayDelete(_ phase: UploadPhase) -> Bool {
        switch phase {
        case .verified, .deduplicated: return true
        case .hashing, .creatingSession, .creatingUpload, .transferring, .completing, .awaitingReceipt, .failed, .cancelled: return false
        }
    }

    public static func mayDelete(record: UploadRecord) -> Bool { mayDelete(record.phase) }

    /// ما يعرضه الإيصال عن النسخ المحلية لنطاقه (أصول الإرسالة الواصلة، أو سجل المادة الواحدة):
    /// `deletable` يُعرض لها خيار الحذف، و`awaitingVerification` في طريقها إلى التحقق فيُقال إن الحذف يأتي بعده.
    /// الفاشل والملغى في أيٍّ منهما لا يدخلان: لا حذف ولا وعد.
    public struct ReceiptChoice: Equatable, Sendable {
        public var deletable: [UploadRecord]
        public var awaitingVerification: [UploadRecord]
    }

    /// `hasLocalCopy`: النسخة ما زالت على الهاتف ولم يحسم المراسل أمرها.
    public static func receiptChoice(scope: [UploadRecord], hasLocalCopy: (UploadRecord) -> Bool) -> ReceiptChoice {
        let withCopy = scope.filter(hasLocalCopy)
        return ReceiptChoice(deletable: withCopy.filter(mayDelete(record:)),
                             awaitingVerification: withCopy.filter { !$0.phase.isTerminal })
    }

    /// سجل الأصل الذي يفتح به «عرض الإيصال» في «موادي»: الأحدث مما تحقّق أو طوبق، وإلا الأحدث مما زال في طريقه إلى التحقق
    /// (فيقول الإيصال إن الحذف بعد التحقق ولا يعرضه)، وإلا لا سجل (يُعرض ما يعرفه الخادم وحده بلا خيار حذف).
    public static func receiptRecord(forMaterial materialId: UUID, in records: [UploadRecord]) -> UploadRecord? {
        let originals = records.filter { $0.materialId == materialId && $0.kind == .original }.sorted { $0.createdAt > $1.createdAt }
        return originals.first(where: mayDelete(record:)) ?? originals.first { !$0.phase.isTerminal }
    }
}
