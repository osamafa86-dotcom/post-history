import Foundation

/// قاعدة الوسم كما في العقد (`MaterialTag`، ADR 0086)، بالمجموعات نفسها من المحارف:
/// 1–40 نقطة ترميز، بلا مسافة من صنف `\s` في JSON Schema في أوله ولا في آخره، وبلا محارف تحكم ولا محارف اتجاه في أي موضع؛
/// وحتى 12 وسمًا بلا تكرار (`MaterialTags`).
public enum MaterialTagRules {
    public static let maxLength = 40
    public static let maxCount = 12

    /// صنف `\s` في JSON Schema (ECMA-262) كما يعدّده وصف `MaterialTag`.
    public static func isSchemaWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    /// C0 وDEL وC1.
    public static func isControl(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x00...0x1F, 0x7F...0x9F: return true
        default: return false
        }
    }

    /// محارف الاتجاه الخفية: U+061C وU+200E/U+200F وU+202A–U+202E وU+2066–U+2069.
    public static func isBidiControl(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069: return true
        default: return false
        }
    }

    /// يطابق نمط العقد حرفًا بحرف.
    public static func isValid(_ tag: String) -> Bool {
        let scalars = Array(tag.unicodeScalars)
        guard let first = scalars.first, let last = scalars.last, scalars.count <= maxLength else { return false }
        if scalars.contains(where: { isControl($0) || isBidiControl($0) }) { return false }
        return !isSchemaWhitespace(first) && !isSchemaWhitespace(last)
    }

    /// المجموعة كما يقبلها العقد: كل وسم صالح، وحتى 12، وبلا تكرار (بمساواة Swift التي تجمعها `Set<String>` في الطلب).
    public static func isValidSet(_ tags: [String]) -> Bool {
        tags.count <= maxCount && Set(tags).count == tags.count && tags.allSatisfy(isValid)
    }

    /// ما يكتبه المراسل قبل التحقق: محارف التحكم المسافية (سطر جديد، جدولة) تصير مسافة، والتحكم والاتجاه الخفيان يُحذفان،
    /// وكل تتابع مسافات يصير مسافة واحدة، والطرفان يُقصّان. فلا يصل الخادم وسم يبدو سليمًا ويُرفض.
    public static func normalize(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for s in raw.unicodeScalars {
            if isSchemaWhitespace(s) {
                pendingSpace = !out.isEmpty
                continue
            }
            if isControl(s) || isBidiControl(s) { continue }
            if pendingSpace { out.append(" ") }
            pendingSpace = false
            out.append(s)
        }
        return String(out)
    }

    public enum AddResult: Equatable, Sendable {
        case added(String)
        /// لم يبقَ شيء بعد التطبيع.
        case empty
        case tooLong
        /// موجود مسبقًا (بلا اعتبار لحالة الأحرف اللاتينية).
        case duplicate
        case limitReached
    }

    /// يضيف ما كتبه المراسل إلى الوسوم إن صلح، ويقول لماذا لم يُضَف.
    @discardableResult
    public static func add(_ raw: String, to tags: inout [String]) -> AddResult {
        let tag = normalize(raw)
        guard !tag.isEmpty else { return .empty }
        guard tag.unicodeScalars.count <= maxLength else { return .tooLong }
        guard !tags.contains(where: { $0.compare(tag, options: [.caseInsensitive]) == .orderedSame }) else { return .duplicate }
        guard tags.count < maxCount else { return .limitReached }
        guard isValid(tag) else { return .empty }
        tags.append(tag)
        return .added(tag)
    }

    /// الفواصل التي تُنهي وسمًا أثناء الكتابة: الفاصلة اللاتينية والعربية والسطر الجديد (كما في النموذج الحيّ).
    public static let separators: Set<Character> = [",", "\u{060C}", "\n"]

    /// يقسم نص الحقل عند الفواصل: ما قبل آخر فاصل وسوم مكتملة، وما بعده يبقى في الحقل.
    public static func split(_ text: String) -> (complete: [String], remainder: String) {
        guard text.contains(where: { separators.contains($0) }) else { return ([], text) }
        var parts = text.split(omittingEmptySubsequences: false, whereSeparator: { separators.contains($0) }).map(String.init)
        let remainder = parts.removeLast()
        return (parts, remainder)
    }
}

/// مطابقة عربية لا تتأثر بالهمزات والتاء المربوطة والألف المقصورة والتشكيل والتطويل، ولا بحالة الأحرف اللاتينية
/// (design-brief.md §5.1).
public enum ArabicFold {
    public static func key(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in s.lowercased().unicodeScalars {
            switch scalar.value {
            case 0x064B...0x065F, 0x0670, 0x0640: continue // التشكيل والألف الخنجرية والتطويل
            case 0x0622, 0x0623, 0x0625, 0x0671: out.append("\u{0627}") // آ أ إ ٱ ← ا
            case 0x0629: out.append("\u{0647}") // ة ← ه
            case 0x0649: out.append("\u{064A}") // ى ← ي
            case 0x0624: out.append("\u{0648}") // ؤ ← و
            case 0x0626: out.append("\u{064A}") // ئ ← ي
            default: out.append(scalar)
            }
        }
        return String(out)
    }
}

/// اقتراحات الوسوم من وسوم المراسل السابقة على هاتفه (قائمة الإدارة تأتي بطلب عقد لاحق، ADR 0086).
public enum TagSuggestions {
    /// بلا كتابة: أحدث الوسوم السابقة. مع الكتابة: ما يبدأ بها أولًا ثم ما يحويها، بالمطابقة العربية المطويّة.
    /// المضاف إلى الإرسال الحالي لا يُقترح مرة ثانية.
    public static func match(_ query: String, history: [String], excluding current: [String], limit: Int = 6) -> [String] {
        let taken = Set(current.map(ArabicFold.key))
        let pool = history.filter { !taken.contains(ArabicFold.key($0)) }
        let q = ArabicFold.key(MaterialTagRules.normalize(query))
        guard !q.isEmpty else { return Array(pool.prefix(limit)) }
        let prefixed = pool.filter { ArabicFold.key($0).hasPrefix(q) }
        let containing = pool.filter { !ArabicFold.key($0).hasPrefix(q) && ArabicFold.key($0).contains(q) }
        return Array((prefixed + containing).prefix(limit))
    }
}

/// وقت التصوير من بيانات الصورة (`shot_at`، «يُقرأ من الملف»): EXIF `DateTimeOriginal` بصيغة «yyyy:MM:dd HH:mm:ss»
/// و`OffsetTimeOriginal` («+02:00») إن وُجد، وإلا منطقة الهاتف الزمنية. لا يُقرأ من الملف موقع ولا معرّف جهاز.
public enum CaptureDate {
    public static func exif(_ value: String, offset: String?, timeZone: TimeZone = .current) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.hasPrefix("0000") else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.timeZone = offset.flatMap(Self.timeZone(offset:)) ?? timeZone
        return formatter.date(from: trimmed)
    }

    /// «+02:00» أو «-0530» إلى منطقة زمنية ثابتة.
    static func timeZone(offset: String) -> TimeZone? {
        let s = offset.trimmingCharacters(in: .whitespaces)
        guard let sign = s.first, sign == "+" || sign == "-" else { return nil }
        let digits = s.dropFirst().filter(\.isNumber)
        guard digits.count == 4, let h = Int(digits.prefix(2)), let m = Int(digits.suffix(2)), h <= 14, m < 60 else { return nil }
        return TimeZone(secondsFromGMT: (sign == "-" ? -1 : 1) * (h * 3600 + m * 60))
    }
}

/// ما ينقص قبل «أرسل N مواد»، بترتيب الشاشة (reporter-v2.md «الإرسال»): الزرّ معطّل ونصّه أول سبب.
public enum SendReadiness {
    public enum Reason: String, CaseIterable, Sendable {
        case files, title, titleTooLongForSet, type, tags, place, sensitivity, followups, displayName, pseudonym
        /// حقول إلزامية في نموذج المكتب لم تُملأ.
        case formFields
        /// النموذج يُحمَّل؛ والآخر: لا شبكة ولا نسخة محفوظة منه (الإرسال يحتاج `form_version`).
        case formLoading, formUnavailable

        /// مفتاح النص في `Localizable.xcstrings`.
        public var labelKey: String { "send.need.\(rawValue)" }
    }

    /// حالة نموذج المكتب كما تعرفها الشاشة.
    public enum FormState: Equatable, Sendable { case ready, missingFields, loading, unavailable }

    public static func reasons(_ d: MaterialDraft, form: FormState) -> [Reason] {
        var out: [Reason] = []
        if d.files.isEmpty { out.append(.files) }
        let issues = DraftValidator.fieldIssues(d)
        if issues.contains(.titleLength) { out.append(.title) }
        if issues.contains(.titleTooLongForSet) { out.append(.titleTooLongForSet) }
        if issues.contains(.typeMissing) { out.append(.type) }
        if d.tags.isEmpty || issues.contains(.tagsInvalid) { out.append(.tags) }
        if issues.contains(.governorateMissing) || issues.contains(.cityMissing) { out.append(.place) }
        switch d.sensitivityGate {
        case nil: out.append(.sensitivity)
        case .yes? where d.sensitivity == nil: out.append(.followups)
        default: break
        }
        if issues.contains(.displayNameMissing) { out.append(.displayName) }
        if issues.contains(.pseudonymMissing) { out.append(.pseudonym) }
        switch form {
        case .ready: break
        case .missingFields: out.append(.formFields)
        case .loading: out.append(.formLoading)
        case .unavailable: out.append(.formUnavailable)
        }
        return out
    }

    /// أول ما ينقص، أو `nil` حين يكتمل كل شيء.
    public static func firstReason(_ d: MaterialDraft, form: FormState) -> Reason? { reasons(d, form: form).first }
}
