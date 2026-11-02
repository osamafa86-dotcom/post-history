import Foundation
import PostHistoryAPI
import UploadCore

// مصدر العرض في «موادي» وتفاصيل المادة والمشغّل (ADR 0089). الترتيب بقرار المنسّق:
// 1. نسخة الأصل على الهاتف إن بقيت (مجلد الرفع حتى يحذفها المراسل بعد الإيصال، `LocalCopyPolicy`): تُعرض كما صُوّرت.
// 2. وإلا مشتق متحقَّق منه على الخادم عبر `getMaterialFileDownloadUrl`: `hls` ثم `proxy` للمشغّل، و`thumbnail` للمعرض.
//    الأصل لا يُطلب له رابط أبدًا (العقد يرفضه)، ولا يُطلب لملف لم يتحقق.
// 3. وإلا حالة «قيد المعالجة» صريحة: خادم التجربة بلا عامل وسائط، فما رُفع أصلًا وحده لا مشتق له هناك.

/// أصل المادة على هذا الهاتف.
public struct LocalOriginal: Equatable, Sendable {
    public let recordId: UUID
    /// نسبي إلى مجلد المستندات كما في سجل الرفع.
    public let relativePath: String
    public let mimeType: String?

    public init(recordId: UUID, relativePath: String, mimeType: String?) {
        self.recordId = recordId
        self.relativePath = relativePath
        self.mimeType = mimeType
    }

    public var isImage: Bool { MaterialMedia.isImage(mimeType: mimeType, path: relativePath) }
}

public enum LocalOriginals {
    /// أحدث أصل لهذه المادة ما زالت نسخته على الهاتف، أيًّا كانت مرحلة رفعه (هو ما صوّره المراسل). النسخة الخفيفة لا تُعدّ:
    /// مشتق يصنعه التطبيق ويحذفه بعد إيصاله. القراءة وحدها؛ لا شيء هنا يغيّر الطابور.
    public static func find(forMaterial materialId: UUID, in records: [UploadRecord],
                            hasLocalCopy: (UploadRecord) -> Bool) -> LocalOriginal? {
        records.filter { $0.materialId == materialId && $0.kind == .original && hasLocalCopy($0) }
            .max { $0.createdAt < $1.createdAt }
            .map { LocalOriginal(recordId: $0.id, relativePath: $0.sourcePath, mimeType: $0.mimeType) }
    }
}

/// الجودة كما يقولها المشغّل: الأصل، أو النسخة الخفيفة بخطوطها (540p أو 360p)، أو البث المتكيّف.
public enum PlaybackQuality: Equatable, Sendable {
    case original
    case lightCopy(lines: Int?)
    case adaptive

    /// النسخة الخفيفة: من وضعها (عاجل 360p، عادي 540p كما في ADR 0075)، وإلا من الضلع الأقصر لأبعادها.
    public static func lightCopy(_ file: MaterialFile) -> PlaybackQuality {
        switch file.proxyMode {
        case .urgent?: return .lightCopy(lines: 360)
        case .normal?: return .lightCopy(lines: 540)
        default:
            if let w = file.width, let h = file.height { return .lightCopy(lines: min(w, h)) }
            return .lightCopy(lines: nil)
        }
    }
}

/// ما يُشغَّل في المشغّل.
public enum PlaybackSource: Equatable, Sendable {
    case local(LocalOriginal)
    /// مشتق متحقَّق منه؛ رابطه يُطلب قبيل التشغيل ولا يُحفظ.
    case remote(fileId: UUID, kind: MaterialFile.Kind, quality: PlaybackQuality)
    /// «قيد المعالجة — تُعرض حين تجهز النسخة».
    case unavailable

    public var quality: PlaybackQuality? {
        switch self {
        case .local: return .original
        case .remote(_, _, let quality): return quality
        case .unavailable: return nil
        }
    }
}

/// ما يُعرض صورةً: مصغّرة البطاقة، أو الصورة في التفاصيل.
public enum PreviewSource: Equatable, Sendable {
    case local(LocalOriginal)
    case remote(fileId: UUID)
    case unavailable
}

public enum PlaybackSourcePolicy {
    /// المشتقات التي يعطيها العقد رابطًا (`getMaterialFileDownloadUrl`)؛ الأصل والملاحظة الصوتية خارجها.
    public static let linkableKinds: Set<MaterialFile.Kind> = [.proxy, .hls, .audio, .thumbnail, .transcript, .captions, .shotList]

    /// أحدث ملف متحقَّق منه من نوع يعطيه العقد رابطًا.
    static func newestVerified(_ kind: MaterialFile.Kind, in m: Material, where extra: (MaterialFile) -> Bool = { _ in true }) -> MaterialFile? {
        guard linkableKinds.contains(kind) else { return nil }
        return m.files.filter { $0.kind == kind && $0.state == .verified && extra($0) }.max { $0.createdAt < $1.createdAt }
    }

    /// المشغّل: الأصل على الهاتف ← `hls` متحقَّق ← `proxy` متحقَّق ← «قيد المعالجة».
    public static func player(for m: Material, local: LocalOriginal?) -> PlaybackSource {
        if let local { return .local(local) }
        if let hls = newestVerified(.hls, in: m) { return .remote(fileId: hls.id, kind: .hls, quality: .adaptive) }
        if let proxy = newestVerified(.proxy, in: m) { return .remote(fileId: proxy.id, kind: .proxy, quality: .lightCopy(proxy)) }
        return .unavailable
    }

    /// مصغّرة البطاقة في المعرض: الأصل على الهاتف ← `thumbnail` متحقَّق ← لا شيء. المادة الحسّاسة لا تُطلب لها معاينة من الخادم
    /// (07c: «لا معاينة سحابية · تُعالَج محليًا»)؛ يظهر لها ما على الهاتف وحده.
    public static func thumbnail(for m: Material, local: LocalOriginal?) -> PreviewSource {
        if let local { return .local(local) }
        guard !m.isSensitive, let thumb = newestVerified(.thumbnail, in: m) else { return .unavailable }
        return .remote(fileId: thumb.id)
    }

    /// الصورة في تفاصيل مادة صورة: الأصل على الهاتف ← نسخة خفيفة صورةً ← `thumbnail` متحقَّق ← لا شيء. للمادة الحسّاسة لا تُطلب
    /// إلا بلمسة المراسل (`requested`)، فلا معاينة تظهر وحدها؛ والمشغّل كذلك لا يطلب رابطًا إلا عند «تشغيل».
    public static func still(for m: Material, local: LocalOriginal?, requested: Bool) -> PreviewSource {
        if let local { return .local(local) }
        guard !m.isSensitive || requested else { return .unavailable }
        if let proxy = newestVerified(.proxy, in: m, where: { MaterialMedia.isImage(mimeType: $0.mimeType) }) { return .remote(fileId: proxy.id) }
        if let thumb = newestVerified(.thumbnail, in: m) { return .remote(fileId: thumb.id) }
        return .unavailable
    }
}

// MARK: - الرابط الموقّع

/// رابط قراءة موقّع قصير العمر (≤ 10 دقائق، `Cache-Control: no-store`): في الذاكرة وحدها طوال المشاهدة، لا في UserDefaults
/// ولا على القرص، ولا يُسجَّل.
public struct SignedURLLease: Equatable, Sendable {
    public let url: URL
    public let expiresAt: Date

    /// هامش قبل الانتهاء: رابط بقي له أقل منه لا يُبدأ به تشغيل (طلبات المدى التالية قد تصل بعد انتهائه).
    public static let safetyMargin: TimeInterval = 60

    public init(url: URL, expiresAt: Date) {
        self.url = url
        self.expiresAt = expiresAt
    }

    public init?(_ link: FileDownloadUrl) {
        guard let url = URL(string: link.url), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        self.init(url: url, expiresAt: link.expiresAt)
    }

    public func isFresh(at now: Date) -> Bool { expiresAt.timeIntervalSince(now) > Self.safetyMargin }
}

/// متى يُطلب رابط جديد. المشغّل لا يبدّل الرابط أثناء العرض بلا داعٍ (كل تبديل انقطاع قصير): يتحقق عند كل بدء أو استئناف،
/// وعند فشل العنصر يجدّده ويستأنف من الموضع نفسه، بحدٍّ يمنع الحلقة.
public enum SignedURLRefresh {
    public enum Decision: Equatable, Sendable { case useCurrent, fetchNew, giveUp }

    /// تجديدان متتاليان بلا تقدّم في العرض ثم يتوقف ويقول ذلك.
    public static let maxRefreshesWithoutProgress = 2

    /// قبل التشغيل أو استئنافه بعد إيقاف، وقبل إعادة المحاولة.
    public static func beforePlayback(_ lease: SignedURLLease?, now: Date) -> Decision {
        guard let lease, lease.isFresh(at: now) else { return .fetchNew }
        return .useCurrent
    }

    /// بعد فشل عنصر التشغيل: رابط انتهى أو قارب ← رابط جديد. رابط ما زال صالحًا ← محاولة واحدة برابط جديد (فشل عابر)، ثم توقف،
    /// لأن السبب حينئذ ليس الرابط. وفي كل حال لا أكثر من `maxRefreshesWithoutProgress` بلا تقدّم.
    public static func afterFailure(_ lease: SignedURLLease?, now: Date, refreshesWithoutProgress: Int) -> Decision {
        if refreshesWithoutProgress >= maxRefreshesWithoutProgress { return .giveUp }
        if let lease, lease.isFresh(at: now), refreshesWithoutProgress >= 1 { return .giveUp }
        return .fetchNew
    }
}

// MARK: - ملفات المادة في التفاصيل

/// صف ملف في «الملفات» بتفاصيل المادة: نوعه وحالة رفعه على الخادم بكلمة ونغمة (لا لون وحده).
public struct MaterialFileRow: Equatable, Sendable, Identifiable {
    public let id: UUID
    public let kindKey: String
    public let stateKey: String
    public let tone: MaterialStatus.SignalTone
    public let sizeBytes: Int?
    public let durationMs: Int?
    public let quality: PlaybackQuality?
    public let receiptNumber: String?
}

public enum MaterialFileList {
    static let order: [MaterialFile.Kind] = [.original, .proxy, .hls, .audio, .thumbnail, .voiceNote, .transcript, .captions, .shotList]

    /// الأصل أولًا ثم المشتقات بترتيب ثابت، والأحدث أولًا داخل النوع الواحد.
    public static func rows(_ files: [MaterialFile]) -> [MaterialFileRow] {
        files.sorted { a, b in
            let ia = order.firstIndex(of: a.kind) ?? order.count, ib = order.firstIndex(of: b.kind) ?? order.count
            return ia != ib ? ia < ib : a.createdAt > b.createdAt
        }
        .map { f in
            let quality: PlaybackQuality?
            switch f.kind {
            case .original: quality = .original
            case .proxy: quality = PlaybackQuality.lightCopy(f)
            case .hls: quality = .adaptive
            default: quality = nil
            }
            return MaterialFileRow(id: f.id, kindKey: kindKey(f.kind), stateKey: stateKey(f.state), tone: tone(f.state),
                                   sizeBytes: f.sizeBytes, durationMs: f.durationMs, quality: quality,
                                   receiptNumber: (f.receiptNumber ?? "").isEmpty ? nil : f.receiptNumber)
        }
    }

    public static func kindKey(_ kind: MaterialFile.Kind) -> String {
        switch kind {
        case .original: return "material.file.original"
        case .proxy: return "material.file.proxy"
        case .hls: return "material.file.hls"
        case .audio: return "material.file.audio"
        case .thumbnail: return "material.file.thumbnail"
        case .voiceNote: return "material.file.voiceNote"
        case .transcript: return "material.file.transcript"
        case .captions: return "material.file.captions"
        case .shotList: return "material.file.shotList"
        default: return "material.file.other"
        }
    }

    public static func stateKey(_ state: MaterialFile.State) -> String {
        switch state {
        case .uploading: return "material.fileState.uploading"
        case .received: return "material.fileState.received"
        case .verified: return "material.fileState.verified"
        case .failed: return "material.fileState.failed"
        default: return "material.state.unknown"
        }
    }

    public static func tone(_ state: MaterialFile.State) -> MaterialStatus.SignalTone {
        switch state {
        case .verified: return .ok
        case .failed: return .danger
        case .received: return .brand
        default: return .muted
        }
    }

    /// كل مفاتيح النصوص الممكنة؛ اختبار يتأكد أن لكلٍّ ترجمة عربية وإنجليزية.
    public static var allTextKeys: [String] {
        Array(Set(MaterialFile.Kind.allCases.map(kindKey) + MaterialFile.State.allCases.map(stateKey))).sorted()
    }
}

// MARK: - شرح الحالات بكلمات بسيطة

extension MaterialStatus {
    /// ما تعنيه الحالة للمراسل بلا مصطلحات تقنية (تفاصيل المادة، 08): «عند مكتب التحرير»، «لا تُعرض للمؤسسات بعد».
    public static func explanationKey(_ s: TechnicalState) -> String {
        switch s {
        case .pending: return "material.explain.technical.pending"
        case .proxyReceived: return "material.explain.technical.proxyReceived"
        case .originalReceived: return "material.explain.technical.originalReceived"
        case .verified: return "material.explain.technical.verified"
        case .failed: return "material.explain.technical.failed"
        default: return "material.explain.unknown"
        }
    }

    public static func explanationKey(_ s: EditorialState) -> String {
        switch s {
        case .inbox: return "material.explain.editorial.inbox"
        case .acknowledged: return "material.explain.editorial.acknowledged"
        case .reviewing: return "material.explain.editorial.reviewing"
        case .needsChanges: return "material.explain.editorial.needsChanges"
        case .accepted: return "material.explain.editorial.accepted"
        case .inProduction: return "material.explain.editorial.inProduction"
        case .finalReview: return "material.explain.editorial.finalReview"
        case .published: return "material.explain.editorial.published"
        case .rejected: return "material.explain.editorial.rejected"
        default: return "material.explain.unknown"
        }
    }

    public static func explanationKey(_ s: RightsState) -> String {
        switch s {
        case .unknown: return "material.explain.rights.unknown"
        case .documented: return "material.explain.rights.documented"
        case .sellable: return "material.explain.rights.sellable"
        case .blocked: return "material.explain.rights.blocked"
        case .withdrawn: return "material.explain.rights.withdrawn"
        default: return "material.explain.unknown"
        }
    }

    public static func explanationKey(_ track: Track, of m: Material) -> String {
        switch track {
        case .technical: return explanationKey(m.technicalState)
        case .editorial: return explanationKey(m.editorialState)
        case .rights: return explanationKey(m.rightsState)
        }
    }

    public static var allExplanationKeys: [String] {
        let t = TechnicalState.allCases.map { explanationKey($0) }
        let e = EditorialState.allCases.map { explanationKey($0) }
        let r = RightsState.allCases.map { explanationKey($0) }
        return Array(Set(t + e + r)).sorted()
    }
}

extension MaterialTimeline {
    /// آخر انتقال على مسار: «منذ 14:32» بجانب شرح الحالة.
    public func latest(_ track: MaterialStatus.Track) -> TransitionRecord? {
        let api: TransitionRecord.Track
        switch track {
        case .technical: api = .technical
        case .editorial: api = .editorial
        case .rights: api = .rights
        }
        return events.first { $0.track == api }
    }
}
