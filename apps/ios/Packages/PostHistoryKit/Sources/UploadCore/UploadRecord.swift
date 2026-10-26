import Foundation
import PostHistoryAPI

/// مرحلة الرفع المحلي. الوعد للمراسل: الاستئناف من آخر جزء أكّده الخادم، لا الاستمرار بعد الإغلاق القسري.
public enum UploadPhase: Codable, Equatable, Sendable {
    /// بصمة SHA-256 للملف كاملًا قبل إنشاء الجلسة (تُرسل `client_sha256`).
    case hashing
    /// `POST /uploads` بمفتاح منع تكرار ثابت للسجل.
    case creatingSession
    /// `POST` tus إلى `tus_endpoint` بالرمز القصير.
    case creatingUpload
    /// أجزاء `PATCH` متتابعة؛ جزء واحد في الطريق ونافذة محدودة مُجهَّزة على القرص.
    case transferring
    /// اكتمل النقل؛ إبلاغ `reported_sha256` ثم انتظار تحقق الخادم.
    case completing
    case awaitingReceipt
    case verified(receiptNumber: String)
    case deduplicated(duplicateOfFileId: UUID?)
    case failed(UploadFailure)
    case cancelled

    public var isTerminal: Bool {
        switch self {
        case .verified, .deduplicated, .failed, .cancelled: return true
        default: return false
        }
    }
}

public enum UploadFailure: String, Codable, Equatable, Sendable {
    /// بصمة الخادم تخالف البصمة المحلية (أو ملف غير صالح).
    case checksumMismatch = "checksum_mismatch"
    case invalidFile = "invalid_file"
    /// رمز الرفع أو الجلسة انتهيا قبل الاكتمال؛ يلزم رفع جديد.
    case expired = "expired"
    /// الخادم أسقط الرفع (404/410 من tus أو `aborted`).
    case aborted = "aborted"
    case storageError = "storage_error"
    /// الملف المحلي لم يعد موجودًا أو تغيّر حجمه.
    case sourceMissing = "source_missing"
    /// رفض نهائي من الخادم (4xx غير قابل للإعادة).
    case rejected = "rejected"
    /// الجلسة خلف بوابة ingest والجهاز لا يستطيع إثبات نفسه (لا App Attest، أو رفض الخادم الشهادة مرارًا).
    case deviceNotAttested = "device_not_attested"
}

/// جزء مُجهَّز على القرص بانتظار إرساله: موضعه وطوله. لا بصمة لكل جزء (قرار ADR 0009: tusd لا يدعم امتداد checksum؛ السلامة ببصمة الملف كاملًا).
public struct PreparedChunk: Codable, Equatable, Sendable {
    public var offset: Int64
    public var length: Int64
    /// اسم ملف الجزء داخل مجلد الأجزاء (لا مسار مطلق؛ المجلد يتغير بين عمليات التشغيل على iOS).
    public var fileName: String

    public init(offset: Int64, length: Int64, fileName: String) {
        self.offset = offset
        self.length = length
        self.fileName = fileName
    }

    public var end: Int64 { offset + length }
}

/// ما يحتاجه النقل من جلسة الرفع التي أنشأها الخادم. رمز الرفع ليس هنا بل في `UploadSecretStore`.
public struct RemoteSession: Codable, Equatable, Sendable {
    public var uploadSessionId: UUID
    public var tusEndpoint: URL
    public var tusMetadata: [String: String]
    public var partSizeBytes: Int64
    public var checksumAlgorithm: String
    public var expiresAt: Date
    public var uploadTokenExpiresAt: Date
    /// الخادم وضع الجلسة خلف بوابة ingest (SEC-07): كل طلب tus يحمل `Ingest-Token`. اختياري كي تُقرأ سجلات أقدم.
    public var ingestTokenRequired: Bool?

    public init(uploadSessionId: UUID, tusEndpoint: URL, tusMetadata: [String: String], partSizeBytes: Int64, checksumAlgorithm: String, expiresAt: Date, uploadTokenExpiresAt: Date, ingestTokenRequired: Bool? = nil) {
        self.uploadSessionId = uploadSessionId
        self.tusEndpoint = tusEndpoint
        self.tusMetadata = tusMetadata
        self.partSizeBytes = partSizeBytes
        self.checksumAlgorithm = checksumAlgorithm
        self.expiresAt = expiresAt
        self.uploadTokenExpiresAt = uploadTokenExpiresAt
        self.ingestTokenRequired = ingestTokenRequired
    }
}

/// سجل رفع واحد كما يُحفظ على القرص. لا يحمل رموزًا ولا إحداثيات.
public struct UploadRecord: Codable, Equatable, Sendable, Identifiable {
    public var id: UUID
    public var materialId: UUID
    public var kind: UploadSessionCreate.Kind
    public var proxyMode: UploadSessionCreate.ProxyMode?
    /// أصل ينتظر نسخته الخفيفة قيد التحضير على الجهاز (ADR 0075): لا تُنشأ جلسته حتى تصل النسخة إلى الطابور أو يُرفع الانتظار.
    /// اختياري كي تُقرأ السجلات المحفوظة قبل هذا الحقل.
    public var awaitsProxy: Bool?
    /// أوقفه المراسل مؤقتًا: لا جزء جديد حتى الاستئناف، والموضع على الخادم محفوظ. اختياري للسجلات الأقدم.
    public var isPaused: Bool?
    /// عنوان المادة وأولويتها لبطاقة الرفع دون اتصال؛ على الجهاز فقط ويمحوهما المسح الطارئ مع السجل.
    public var materialTitle: String?
    public var materialPriority: String?
    /// الملف الأصلي داخل حاوية التطبيق (مسار نسبي إلى مجلد المستندات) أو مسار مطلق في الاختبارات.
    public var sourcePath: String
    public var filename: String
    public var mimeType: String?
    public var sizeBytes: Int64
    public var createdAt: Date
    public var phase: UploadPhase = .hashing
    public var sha256Hex: String?
    public var createIdempotencyKey: String
    public var completeIdempotencyKey: String
    public var remote: RemoteSession?
    public var tusUploadURL: URL?
    /// حجم الجزء الذي يرسله الهاتف؛ يُثبَّت عند البدء من سياسة الشبكة ولا يتغير خلال الجلسة.
    public var chunkSizeBytes: Int64 = 0
    /// آخر `Upload-Offset` أكّده الخادم.
    public var confirmedOffset: Int64 = 0
    /// الجزء الذي في الطريق الآن (إن وُجد) ثم الأجزاء المُجهَّزة بعده بالترتيب.
    public var prepared: [PreparedChunk] = []
    public var inFlightOffset: Int64?
    public var attempt: Int = 0
    public var lastErrorCode: String?
    public var updatedAt: Date

    public init(id: UUID = UUID(), materialId: UUID, kind: UploadSessionCreate.Kind, proxyMode: UploadSessionCreate.ProxyMode? = nil, sourcePath: String, filename: String, mimeType: String?, sizeBytes: Int64, now: Date = Date()) {
        self.id = id
        self.materialId = materialId
        self.kind = kind
        self.proxyMode = proxyMode
        self.sourcePath = sourcePath
        self.filename = filename
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.createdAt = now
        self.updatedAt = now
        self.createIdempotencyKey = "upload-create-\(id.uuidString.lowercased())"
        self.completeIdempotencyKey = "upload-complete-\(id.uuidString.lowercased())"
    }

    public var fractionTransferred: Double { sizeBytes == 0 ? 0 : Double(confirmedOffset) / Double(sizeBytes) }
}

/// حدث يصل الواجهة (وLive Activity لاحقًا). لا أسماء ملفات ولا مسارات.
public enum UploadEvent: Equatable, Sendable {
    case phaseChanged(id: UUID, phase: UploadPhase)
    case progress(id: UUID, confirmedOffset: Int64, sizeBytes: Int64)
    case retryScheduled(id: UUID, attempt: Int, after: TimeInterval)
}
