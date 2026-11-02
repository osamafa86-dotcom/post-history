import Foundation
import PostHistoryAPI

/// ما يتذكّره التطبيق للمراسل بين إرسال وآخر (reporter-v2.md «الإرسال»): المحافظة والمدينة من آخر إرسال، واسم الظهور
/// من الإعدادات (`real_name` افتراضيًا)، ووسومه السابقة اقتراحاتٍ (لا تُنسخ إلى الإرسال الجديد).
/// الوسوم نص حرّ قد يحوي أسماءً حساسة (ADR 0086)، فتبقى في ملف محمي على الجهاز ويمحوها المسح الطارئ والخروج والإبطال.
/// لا إحداثيات هنا أبدًا.
public struct ReporterMemory: Codable, Equatable, Sendable {
    public static let tagHistoryLimit = 60

    public var governorate: String
    public var city: String
    /// الأحدث أولًا، بلا تكرار بالمطابقة العربية المطويّة.
    public var recentTags: [String]
    public var displayMode: DisplayName.Mode?
    public var pseudonym: String

    public init(governorate: String = "", city: String = "", recentTags: [String] = [], displayMode: DisplayName.Mode? = nil, pseudonym: String = "") {
        self.governorate = governorate
        self.city = city
        self.recentTags = recentTags
        self.displayMode = displayMode
        self.pseudonym = pseudonym
    }

    /// كل الحقول اختيارية في الملف كي لا يضيع ما حُفظ إن أُضيف حقل لاحقًا.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        governorate = try c.decodeIfPresent(String.self, forKey: .governorate) ?? ""
        city = try c.decodeIfPresent(String.self, forKey: .city) ?? ""
        recentTags = try c.decodeIfPresent([String].self, forKey: .recentTags) ?? []
        displayMode = try c.decodeIfPresent(DisplayName.Mode.self, forKey: .displayMode)
        pseudonym = try c.decodeIfPresent(String.self, forKey: .pseudonym) ?? ""
    }

    public var hasPlace: Bool { !governorate.isEmpty && !city.isEmpty }

    /// اسم الظهور الافتراضي للإرسال الجديد.
    public var effectiveDisplayMode: DisplayName.Mode {
        guard let displayMode, displayMode != .unknownDefaultOpenApi else { return .realName }
        return displayMode
    }

    /// بعد إرسال ناجح: المكان يصير «من آخر إرسال»، ووسومه تتقدّم قائمة الاقتراحات.
    public mutating func rememberSend(governorate: String, city: String, tags: [String]) {
        let g = governorate.trimmingCharacters(in: .whitespacesAndNewlines)
        let c = city.trimmingCharacters(in: .whitespacesAndNewlines)
        if !g.isEmpty, !c.isEmpty {
            self.governorate = g
            self.city = c
        }
        let fresh = tags.map(ArabicFold.key)
        let kept = recentTags.filter { !fresh.contains(ArabicFold.key($0)) }
        var seen = Set<String>()
        recentTags = Array((tags + kept).filter { seen.insert(ArabicFold.key($0)).inserted }.prefix(Self.tagHistoryLimit))
    }

    /// يملأ مسودة جديدة بما يُتذكَّر دون أن يكتب فوق ما فيها: المكان إن كان فارغًا، واسم الظهور إن لم يُختر.
    public func prefill(_ draft: inout MaterialDraft) {
        if draft.governorate.isEmpty, draft.city.isEmpty, hasPlace {
            draft.governorate = governorate
            draft.city = city
        }
        if draft.displayMode == nil {
            draft.displayMode = effectiveDisplayMode
            if effectiveDisplayMode == .pseudonym, draft.pseudonym.isEmpty { draft.pseudonym = pseudonym }
        }
    }

    /// هل المكان في المسودة هو المتذكَّر من آخر إرسال (لعبارة «من آخر إرسال» تحت شريحة المكان).
    public func isRemembered(governorate: String, city: String) -> Bool {
        hasPlace && governorate == self.governorate && city == self.city
    }
}

/// ملف الذاكرة: JSON بحماية الملف الكاملة وخارج النسخ الاحتياطي، كالمسودات (ADR 0076).
public final class ReporterMemoryStore: @unchecked Sendable {
    public let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL) {
        self.fileURL = fileURL
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    public func load() -> ReporterMemory {
        lock.withLock {
            guard let data = try? Data(contentsOf: fileURL) else { return ReporterMemory() }
            return (try? JSONDecoder().decode(ReporterMemory.self, from: data)) ?? ReporterMemory()
        }
    }

    public func save(_ memory: ReporterMemory) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(memory)
        #if canImport(Darwin) && !os(macOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        try lock.withLock {
            try data.write(to: fileURL, options: options)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = fileURL
            try? url.setResourceValues(values)
        }
    }

    /// يقرأ ويعدّل ويحفظ، ويعيد الناتج.
    @discardableResult
    public func update(_ change: (inout ReporterMemory) -> Void) -> ReporterMemory {
        var memory = load()
        change(&memory)
        try? save(memory)
        return memory
    }

    /// الخروج والإبطال: لا يبقى للمراسل السابق مكان ولا وسوم على الهاتف.
    public func clear() {
        lock.withLock { _ = try? FileManager.default.removeItem(at: fileURL) }
    }
}
