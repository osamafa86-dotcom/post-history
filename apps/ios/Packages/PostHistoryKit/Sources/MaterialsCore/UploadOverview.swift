import Foundation

/// ملف في شاشة الرفع كما يحوّله التطبيق من سجل نواة الرفع (05 في reporter-v2.md): الحجم وما وصل والحالة فقط،
/// بلا مسار ولا اسم مصدر.
public struct UploadItem: Equatable, Sendable, Identifiable {
    public enum State: Equatable, Sendable {
        /// بصمة أو إنشاء جلسة أو انتظار النسخة الخفيفة.
        case preparing
        case transferring
        /// وصلت البايتات وتنتظر تحقق الخادم وإيصاله.
        case finishing
        /// تحقّق الخادم من الأصل (إيصال أو مطابقة لأصل سابق).
        case arrived
        case failed
        case cancelled
    }

    public var id: UUID
    public var materialId: UUID
    public var sizeBytes: Int64
    public var confirmedOffset: Int64
    public var state: State
    public var paused: Bool
    /// النسخة الخفيفة لهذه المادة وصلت وتحقّقت: المحرر يستطيع مشاهدتها.
    public var previewArrived: Bool

    public init(id: UUID, materialId: UUID, sizeBytes: Int64, confirmedOffset: Int64, state: State, paused: Bool = false, previewArrived: Bool = false) {
        self.id = id
        self.materialId = materialId
        self.sizeBytes = sizeBytes
        self.confirmedOffset = confirmedOffset
        self.state = state
        self.paused = paused
        self.previewArrived = previewArrived
    }

    public var isActive: Bool { state == .preparing || state == .transferring || state == .finishing }
}

/// مراحل الملف الثلاث (الخطة: «وصلت المعاينة» · «وصل الأصل وتحقّق» · «اكتملت النسخة الاحتياطية»).
/// الثالثة لا يحملها العقد اليوم (لا حقل لنسخة المزوّد الثاني في `MaterialFile`)، فلا يبلغها ملف هنا ولا تُدّعى (ADR 0088).
public enum UploadStage: Int, Comparable, Sendable {
    case none = 0, preview = 1, original = 2, backup = 3

    public static func < (a: UploadStage, b: UploadStage) -> Bool { a.rawValue < b.rawValue }

    /// مفتاح كلمة المرحلة في `Localizable.xcstrings`.
    public var labelKey: String {
        switch self {
        case .none: return "upload.stage.none"
        case .preview: return "upload.stage.preview"
        case .original: return "upload.stage.original"
        case .backup: return "upload.stage.backup"
        }
    }
}

/// حساب ما تعرضه دوائر البثّ وصفوف الرفع.
public enum UploadOverview {
    /// حالة الدوائر: تنبض أثناء الرفع، وتهدأ بانتظار الشبكة، وتمتلئ عند الوصول، وتحمرّ عند فشل يحتاج المراسل.
    public enum RingState: String, Sendable { case uploading, waiting, done, failed }

    public static func stage(_ item: UploadItem) -> UploadStage {
        if item.state == .arrived { return .original }
        return item.previewArrived ? .preview : .none
    }

    /// نسبة ما وصل بوزن الحجم؛ الواصل كامل، والملغى خارج الحساب. بلا ملفات: 0.
    public static func fraction(_ items: [UploadItem]) -> Double {
        let counted = items.filter { $0.state != .cancelled }
        let total = counted.reduce(Int64(0)) { $0 + max($1.sizeBytes, 0) }
        guard total > 0 else { return counted.isEmpty ? 0 : (counted.allSatisfy { $0.state == .arrived } ? 1 : 0) }
        let done = counted.reduce(Int64(0)) { sum, item in
            sum + (item.state == .arrived ? max(item.sizeBytes, 0) : min(max(item.confirmedOffset, 0), max(item.sizeBytes, 0)))
        }
        return min(1, Double(done) / Double(total))
    }

    /// `online`: الشبكة متاحة بسياسة الرفع (Wi‑Fi فقط إن فُعّل).
    public static func ringState(_ items: [UploadItem], online: Bool) -> RingState {
        let counted = items.filter { $0.state != .cancelled }
        if counted.contains(where: { $0.state == .failed }) { return .failed }
        let active = counted.filter(\.isActive)
        if active.isEmpty { return counted.isEmpty ? .waiting : .done }
        if !online || active.allSatisfy(\.paused) { return .waiting }
        return .uploading
    }

    /// كم ملفًا وصلت معاينته (نسخته الخفيفة أو أصله).
    public static func previewCount(_ items: [UploadItem]) -> Int {
        items.filter { stage($0) >= .preview }.count
    }

    /// الإيصال الاحتفالي يظهر حين يصل كل ما بقي من الإرسالة: كل ملف غير ملغى وصل، وواحد على الأقل.
    public static func isComplete(_ items: [UploadItem]) -> Bool {
        let counted = items.filter { $0.state != .cancelled }
        return !counted.isEmpty && counted.allSatisfy { $0.state == .arrived }
    }
}
