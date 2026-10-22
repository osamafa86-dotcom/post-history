import Foundation

/// مصدر رمز بوابة ingest (SEC-07، ADR 0011) لجلسة رفع. على الجهاز: App Attest ثم `POST /uploads/{id}/ingest-token`
/// (الهدف `DeviceAttestation`). الرمز قصير العمر (≤ 15 دقيقة) فلا يُحفظ على القرص؛ المصدر يخزّنه في الذاكرة حتى قرب انتهائه.
public protocol IngestTokenProvider: Sendable {
    /// رمز صالح للجلسة. `forceRefresh` بعد `401` من البوابة: يُهمل المخزَّن ويُطلب رمز جديد.
    func ingestToken(uploadSessionId: UUID, forceRefresh: Bool) async throws -> String
    /// يُنسى ما في الذاكرة لهذه الجلسة (عند انتهاء الرفع أو إلغائه).
    func forget(uploadSessionId: UUID) async
}

public enum IngestTokenError: Error, Equatable, Sendable {
    /// الجهاز لا يدعم App Attest (أجهزة قديمة، محاكي) أو لا مصدر للرمز: لا رفع خلف البوابة.
    case unsupported
    /// الخادم رفض شهادة الجهاز نهائيًا بعد إعادة التسجيل.
    case attestationRejected
    /// عطل مؤقت (Apple أو الشبكة أو `429`/`503`): يُعاد بعد مهلة.
    case temporarilyUnavailable
}
