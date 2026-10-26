import Foundation
import FormEngine
import PostHistoryAPI

/// مسودة «مادة جديدة» (المواصفة A1): كل الخطوات محفوظة على الجهاز حتى الإرسال، بمفتاح تكرار ثابت لإنشاء المادة.
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

        public init(relativePath: String, filename: String, sizeBytes: Int64, mimeType: String?, isVideo: Bool, durationSeconds: Double?) {
            self.relativePath = relativePath
            self.filename = filename
            self.sizeBytes = sizeBytes
            self.mimeType = mimeType
            self.isVideo = isVideo
            self.durationSeconds = durationSeconds
        }
    }

    public var id: UUID
    public var file: PickedFile?
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
    /// `Idempotency-Key` لـ `POST /materials`: ثابت للمسودة، فإعادة الإرسال بعد انقطاع لا تنشئ مادة ثانية.
    public var createIdempotencyKey: String
    public var createdMaterialId: UUID?
    public var updatedAt: Date

    public init(id: UUID = UUID(), now: Date = Date()) {
        self.id = id
        file = nil
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
}

/// تحقق الخطوتين الأولى والثانية (العقد والخطة). النموذج الديناميكي يتحقق منه `FormValidator` المشترك.
public enum DraftValidator {
    public enum Issue: String, CaseIterable, Sendable {
        case fileMissing, titleLength, typeMissing, governorateMissing, cityMissing, priorityMissing
        case sensitivityUnanswered, displayNameMissing, pseudonymMissing

        /// مفتاح النص في `Localizable.xcstrings`.
        public var labelKey: String { "draft.issue.\(rawValue)" }
    }

    public static let titleRange = 5...80

    /// طول العنوان بنقاط الترميز كما يعدّها الخادم (لا بوحدات UTF-16).
    public static func titleLength(_ title: String) -> Int { title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count }

    public static func fileIssues(_ d: MaterialDraft) -> [Issue] { d.file == nil ? [.fileMissing] : [] }

    public static func fieldIssues(_ d: MaterialDraft) -> [Issue] {
        var issues: [Issue] = []
        if !titleRange.contains(titleLength(d.title)) { issues.append(.titleLength) }
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
    public static func materialCreate(_ d: MaterialDraft, dynamicFields: [String: JSONValue]) -> MaterialCreate? {
        guard fileIssues(d).isEmpty, fieldIssues(d).isEmpty, let priority = d.priority, let sensitivity = d.sensitivity,
              let mode = d.displayMode, let version = d.formVersion else { return nil }
        return MaterialCreate(title: d.title.trimmingCharacters(in: .whitespacesAndNewlines), materialTypes: d.materialTypes, governorate: d.governorate,
                              city: d.city, priority: priority, sensitivity: sensitivity,
                              displayName: DisplayName(mode: mode, pseudonym: mode == .pseudonym ? d.pseudonym : nil),
                              formVersion: version, dynamicFields: dynamicFields)
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
