import Foundation
import FormEngine
import PostHistoryAPI

/// مسودة «مادة جديدة» (المواصفة A1): كل الخطوات محفوظة على الجهاز حتى الإرسال، بمفتاح تكرار ثابت لإنشاء المادة.
/// الملفات المختارة تتشارك البيانات، ولكل ملف مادته (الخادم يحتفظ بأصل واحد للمادة، ADR 0081) ومفتاح إنشائه الثابت.
/// لا إحداثيات ولا معرّف جهاز؛ المحافظة والمدينة نصًّا كما في العقد.
public struct MaterialDraft: Codable, Equatable, Sendable, Identifiable {
    public struct PickedFile: Codable, Equatable, Sendable {
        /// نسبي إلى مجلد المستندات (نسخة الأصل كما هي في مجلد الرفع).
        public var relativePath: String
        public var filename: String
        public var sizeBytes: Int64
        public var mimeType: String?
        public var isVideo: Bool
        public var durationSeconds: Double?
        /// `Idempotency-Key` لإنشاء مادة هذا الملف: يُولَّد مرة ويُحفظ مع المسودة، فإعادة الإرسال بعد انقطاع لا تنشئ مادة ثانية.
        public var createIdempotencyKey: String
        /// مادة هذا الملف إن أُنشئت ولم يدخل الملف الطابور بعد؛ معها لا يُعاد الإنشاء.
        public var createdMaterialId: UUID?
        /// لاحقة العنوان (` (i/N)`) تُثبَّت عند أول محاولة إرسال لمجموعة، كي لا يتغير ترقيم ما بقي بعد فشل جزئي.
        public var titleSuffix: String?

        public static func newCreateKey() -> String { "material-create-\(UUID().uuidString.lowercased())" }

        public init(relativePath: String, filename: String, sizeBytes: Int64, mimeType: String?, isVideo: Bool, durationSeconds: Double?,
                    createIdempotencyKey: String = PickedFile.newCreateKey(), createdMaterialId: UUID? = nil, titleSuffix: String? = nil) {
            self.relativePath = relativePath
            self.filename = filename
            self.sizeBytes = sizeBytes
            self.mimeType = mimeType
            self.isVideo = isVideo
            self.durationSeconds = durationSeconds
            self.createIdempotencyKey = createIdempotencyKey
            self.createdMaterialId = createdMaterialId
            self.titleSuffix = titleSuffix
        }

        /// مسودات الإصدارات السابقة بلا هذه الحقول: يُولَّد المفتاح الناقص هنا (ويُحفظ عند أول حفظ للمسودة).
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            relativePath = try c.decode(String.self, forKey: .relativePath)
            filename = try c.decode(String.self, forKey: .filename)
            sizeBytes = try c.decode(Int64.self, forKey: .sizeBytes)
            mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType)
            isVideo = try c.decode(Bool.self, forKey: .isVideo)
            durationSeconds = try c.decodeIfPresent(Double.self, forKey: .durationSeconds)
            createIdempotencyKey = try c.decodeIfPresent(String.self, forKey: .createIdempotencyKey) ?? PickedFile.newCreateKey()
            createdMaterialId = try c.decodeIfPresent(UUID.self, forKey: .createdMaterialId)
            titleSuffix = try c.decodeIfPresent(String.self, forKey: .titleSuffix)
        }
    }

    /// أقصى عدد ملفات في المادة الواحدة (اختيار المعرض يحدّ نفسه به).
    public static let maxFiles = 20

    public var id: UUID
    /// الملفات بترتيب اختيارها؛ لكلٍّ مادته بالبيانات المشتركة نفسها. فارغة = لم يُختر شيء بعد.
    public var files: [PickedFile]
    /// وضع النسخة الخفيفة (`ProxyChoice.rawValue`)، و«اختاره المراسل» يمنع إعادة الاقتراح فوقه.
    public var lightCopy: String?
    public var lightCopyChosenByReporter: Bool
    public var title: String
    public var materialTypes: Set<MaterialType>
    public var governorate: String
    public var city: String
    public var priority: Priority?
    /// الأسئلة الثلاثة بلا قيمة افتراضية: `nil` لم يُجب.
    public var minors: Bool?
    public var injured: Bool?
    public var graphic: Bool?
    public var displayMode: DisplayName.Mode?
    public var pseudonym: String
    public var formVersion: Int?
    public var dynamicValues: [String: FormValue]
    public var step: Int
    /// مفتاح إنشاء المسودة القديمة ذات الملف الواحد: يرثه ذلك الملف عند الترحيل. الجديدة تستعمل مفتاح كل ملف.
    public var createIdempotencyKey: String
    public var createdMaterialId: UUID?
    public var updatedAt: Date

    public init(id: UUID = UUID(), now: Date = Date()) {
        self.id = id
        files = []
        lightCopy = nil
        lightCopyChosenByReporter = false
        title = ""
        materialTypes = []
        governorate = ""
        city = ""
        priority = nil
        minors = nil
        injured = nil
        graphic = nil
        displayMode = nil
        pseudonym = ""
        formVersion = nil
        dynamicValues = [:]
        step = 1
        createIdempotencyKey = "material-create-\(id.uuidString.lowercased())"
        createdMaterialId = nil
        updatedAt = now
    }

    public var sensitivity: Sensitivity? {
        guard let minors, let injured, let graphic else { return nil }
        return Sensitivity(minors: minors, injured: injured, graphic: graphic)
    }

    /// مجموع أحجام الملفات المختارة (للمراجعة).
    public var totalSizeBytes: Int64 { files.reduce(0) { $0 + $1.sizeBytes } }

    public var videoCount: Int { files.filter(\.isVideo).count }

    /// لاحقة الملف في موضعه `index` (من 0): المثبَّتة إن وُجدت، وإلا المحسوبة من حجم المجموعة.
    public func titleSuffix(at index: Int) -> String {
        files[index].titleSuffix ?? DraftValidator.titleSuffix(position: index + 1, of: files.count)
    }

    /// عنوان مادة الملف في الموضع `index`.
    public func materialTitle(at index: Int) -> String {
        title.trimmingCharacters(in: .whitespacesAndNewlines) + titleSuffix(at: index)
    }

    /// يثبّت لاحقة كل ملف لم تُثبَّت بعد (عند أول محاولة إرسال) إن كانت المجموعة أكثر من ملف.
    public mutating func pinTitleSuffixes() {
        guard files.count > 1 else { return }
        for i in files.indices where files[i].titleSuffix == nil {
            files[i].titleSuffix = DraftValidator.titleSuffix(position: i + 1, of: files.count)
        }
    }

    /// مدة أطول فيديو في المجموعة؛ عليها يُبنى اقتراح النسخة الخفيفة لكل الفيديوهات. `nil` إن لم يكن فيها فيديو.
    public var longestVideoSeconds: Double? {
        let durations = files.filter(\.isVideo).map { $0.durationSeconds ?? 0 }
        return durations.max()
    }

    /// هل أدخل المراسل شيئًا يضيع بإغلاق الورقة: ملف مختار أو أي حقل مكتوب أو مجاب. يمنع الإغلاق بالسحب ويستدعي سؤال التأكيد.
    public var hasInput: Bool {
        if !files.isEmpty { return true }
        if !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if !governorate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if !city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if !pseudonym.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if !materialTypes.isEmpty || priority != nil || minors != nil || injured != nil || graphic != nil || displayMode != nil { return true }
        return dynamicValues.contains { !$0.value.isEmpty }
    }

    // المسودات المحفوظة قبل دعم عدة ملفات تحمل مفتاح `file` (ملف واحد)؛ تُقرأ وتصير مصفوفة بعنصر واحد.
    // الكتابة دائمًا بمفتاح `files`. باقي الحقول بالترميز المركّب نفسه فلا تتغير صيغتها.
    private struct LegacyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
        static let file = LegacyKey(stringValue: "file")!
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        let draftKey = try c.decode(String.self, forKey: .createIdempotencyKey)
        let draftMaterial = try c.decodeIfPresent(UUID.self, forKey: .createdMaterialId)
        if let current = try c.decodeIfPresent([PickedFile].self, forKey: .files) {
            files = current
        } else {
            // مسودة قديمة بملف واحد: يرث ملفها مفتاح المسودة ومادتها المنشأة، فتبقى إعادة المحاولة بلا تكرار.
            let legacy = try decoder.container(keyedBy: LegacyKey.self)
            files = try legacy.decodeIfPresent(PickedFile.self, forKey: .file).map { old in
                var migrated = old
                migrated.createIdempotencyKey = draftKey
                migrated.createdMaterialId = draftMaterial
                return [migrated]
            } ?? []
        }
        lightCopy = try c.decodeIfPresent(String.self, forKey: .lightCopy)
        lightCopyChosenByReporter = try c.decode(Bool.self, forKey: .lightCopyChosenByReporter)
        title = try c.decode(String.self, forKey: .title)
        materialTypes = try c.decode(Set<MaterialType>.self, forKey: .materialTypes)
        governorate = try c.decode(String.self, forKey: .governorate)
        city = try c.decode(String.self, forKey: .city)
        priority = try c.decodeIfPresent(Priority.self, forKey: .priority)
        minors = try c.decodeIfPresent(Bool.self, forKey: .minors)
        injured = try c.decodeIfPresent(Bool.self, forKey: .injured)
        graphic = try c.decodeIfPresent(Bool.self, forKey: .graphic)
        displayMode = try c.decodeIfPresent(DisplayName.Mode.self, forKey: .displayMode)
        pseudonym = try c.decode(String.self, forKey: .pseudonym)
        formVersion = try c.decodeIfPresent(Int.self, forKey: .formVersion)
        dynamicValues = try c.decode([String: FormValue].self, forKey: .dynamicValues)
        step = try c.decode(Int.self, forKey: .step)
        createIdempotencyKey = draftKey
        createdMaterialId = draftMaterial
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    }
}

/// تحقق الخطوتين الأولى والثانية (العقد والخطة). النموذج الديناميكي يتحقق منه `FormValidator` المشترك.
public enum DraftValidator {
    public enum Issue: String, CaseIterable, Sendable {
        case fileMissing, titleLength, typeMissing, governorateMissing, cityMissing, priorityMissing
        case sensitivityUnanswered, displayNameMissing, pseudonymMissing
        /// العنوان في حدوده لكنه لا يتسع للاحقة العدّاد ` (i/N)` حين يكون الملفات أكثر من واحد.
        case titleTooLongForSet

        /// مفتاح النص في `Localizable.xcstrings`.
        public var labelKey: String { "draft.issue.\(rawValue)" }
    }

    public static let titleRange = 5...80

    /// طول العنوان بنقاط الترميز كما يعدّها الخادم (لا بوحدات UTF-16).
    public static func titleLength(_ title: String) -> Int { title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count }

    /// لاحقة العنوان لملف في الموضع `position` (من 1) من `count`: فارغة لملف واحد.
    /// أرقام ASCII بلا محارف تحكم خفية (لا تُخزَّن في العنوان): «2/5» تبقى مرتبة داخل النص العربي بخوارزمية الاتجاه.
    public static func titleSuffix(position: Int, of count: Int) -> String {
        guard count > 1 else { return "" }
        return " (\(position)/\(count))"
    }

    /// طول أطول لاحقة لمجموعة من `count` ملفات بنقاط الترميز (لاحقة آخر ملف).
    public static func longestSuffixLength(forFileCount count: Int) -> Int {
        titleSuffix(position: count, of: count).unicodeScalars.count
    }

    /// أقصى طول للعنوان الأساسي مع لاحقة المجموعة.
    public static func titleLimit(forFileCount count: Int) -> Int {
        titleRange.upperBound - longestSuffixLength(forFileCount: count)
    }

    public static func fileIssues(_ d: MaterialDraft) -> [Issue] { d.files.isEmpty ? [.fileMissing] : [] }

    public static func fieldIssues(_ d: MaterialDraft) -> [Issue] {
        var issues: [Issue] = []
        let length = titleLength(d.title)
        if !titleRange.contains(length) {
            issues.append(.titleLength)
        } else {
            // اللواحق المثبَّتة بعد فشل جزئي قد تكون أطول من المحسوبة لما بقي.
            let suffixes = d.files.indices.map { d.titleSuffix(at: $0).unicodeScalars.count }
            if let longest = suffixes.max(), length + longest > titleRange.upperBound { issues.append(.titleTooLongForSet) }
        }
        if d.materialTypes.subtracting([.unknownDefaultOpenApi]).isEmpty { issues.append(.typeMissing) }
        if d.governorate.trimmingCharacters(in: .whitespaces).isEmpty { issues.append(.governorateMissing) }
        if d.city.trimmingCharacters(in: .whitespaces).isEmpty { issues.append(.cityMissing) }
        if d.priority == nil { issues.append(.priorityMissing) }
        if d.sensitivity == nil { issues.append(.sensitivityUnanswered) }
        switch d.displayMode {
        case nil: issues.append(.displayNameMissing)
        case .pseudonym? where d.pseudonym.trimmingCharacters(in: .whitespaces).isEmpty: issues.append(.pseudonymMissing)
        default: break
        }
        return issues
    }

    /// جسم `POST /materials` من مسودة مكتملة، أو `nil` إن بقي نقص.
    /// `title`: عنوان مادة ملف بعينه (الأساسي مع لاحقته)؛ بلا تمريره يُستعمل عنوان المسودة.
    public static func materialCreate(_ d: MaterialDraft, title: String? = nil, dynamicFields: [String: JSONValue]) -> MaterialCreate? {
        guard fileIssues(d).isEmpty, fieldIssues(d).isEmpty, let priority = d.priority, let sensitivity = d.sensitivity,
              let mode = d.displayMode, let version = d.formVersion else { return nil }
        return MaterialCreate(title: title ?? d.title.trimmingCharacters(in: .whitespacesAndNewlines), materialTypes: d.materialTypes, governorate: d.governorate,
                              city: d.city, priority: priority, sensitivity: sensitivity,
                              displayName: DisplayName(mode: mode, pseudonym: mode == .pseudonym ? d.pseudonym : nil),
                              formVersion: version, dynamicFields: dynamicFields)
    }
}

/// إرسال المسودة: مادة لكل ملف بالبيانات المشتركة، بالترتيب، وكلٌّ بمفتاحه الثابت. ما أُدخل الطابور يُسقَط من المسودة،
/// وعند الفشل يرجع ما بقي (ومعه مادة الملف الذي أُنشئت مادته ولم يُدخل) فلا يُنشأ شيء ولا يُدخل مرتين.
public enum DraftSubmission {
    public enum Failure: Error, Equatable { case incomplete }

    public struct Outcome {
        /// المسودة بعد الإرسال: بلا الملفات التي دخلت الطابور.
        public var draft: MaterialDraft
        /// أول خطأ؛ `nil` إن اكتمل الإرسال وصارت `draft.files` فارغة.
        public var error: Error?
        public var enqueuedCount: Int
    }

    /// `create(key, body)` تعيد معرّف المادة؛ `enqueue(file, materialId, body)` تُدخل الملف أصلًا لتلك المادة.
    @MainActor
    public static func run(_ input: MaterialDraft, dynamicFields: [String: JSONValue],
                           create: (String, MaterialCreate) async throws -> UUID,
                           enqueue: (MaterialDraft.PickedFile, UUID, MaterialCreate) async throws -> Void) async -> Outcome {
        var draft = input
        draft.pinTitleSuffixes()
        var enqueued = 0
        while let file = draft.files.first {
            let title = draft.materialTitle(at: 0)
            guard let body = DraftValidator.materialCreate(draft, title: title, dynamicFields: dynamicFields) else {
                return Outcome(draft: draft, error: Failure.incomplete, enqueuedCount: enqueued)
            }
            do {
                let materialId: UUID
                if let existing = file.createdMaterialId {
                    materialId = existing
                } else {
                    materialId = try await create(file.createIdempotencyKey, body)
                    draft.files[0].createdMaterialId = materialId
                }
                try await enqueue(draft.files[0], materialId, body)
                draft.files.removeFirst()
                enqueued += 1
            } catch {
                return Outcome(draft: draft, error: error, enqueuedCount: enqueued)
            }
        }
        return Outcome(draft: draft, error: nil, enqueuedCount: enqueued)
    }
}

/// المسودات على القرص: ملف JSON لكل مسودة بحماية الملف الكاملة، خارج النسخ الاحتياطي، ويمحوها المسح الطارئ مع مجلدها.
public final class FileDraftStore: @unchecked Sendable {
    public let directory: URL
    private let lock = NSLock()
    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return e }()
    private let decoder = JSONDecoder()

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }

    private func url(_ id: UUID) -> URL { directory.appendingPathComponent("\(id.uuidString.lowercased()).json") }

    public func save(_ draft: MaterialDraft) throws {
        let data = try encoder.encode(draft)
        #if canImport(Darwin) && !os(macOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        try lock.withLock { try data.write(to: url(draft.id), options: options) }
    }

    public func loadAll() -> [MaterialDraft] {
        lock.withLock {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            return files.filter { $0.pathExtension == "json" }
                .compactMap { try? decoder.decode(MaterialDraft.self, from: Data(contentsOf: $0)) }
                .sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    public func delete(_ id: UUID) {
        lock.withLock { _ = try? FileManager.default.removeItem(at: url(id)) }
    }
}
