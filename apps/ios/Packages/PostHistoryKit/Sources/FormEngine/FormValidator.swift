import Foundation
import PostHistoryAPI

/// رمز خطأ التحقق كما تُعيده الواجهات الثلاث والخادم (`tools/acceptance/form-conformance/README.md`).
public enum FieldErrorCode: String, Codable, Equatable, Sendable, CaseIterable {
    case required, type
    case minLength = "min_length", maxLength = "max_length", pattern
    case min, max, option
    case minItems = "min_items", maxItems = "max_items"
    case notBefore = "not_before", notAfter = "not_after"
    case accept, maxSizeBytes = "max_size_bytes"
}

public struct FieldError: Equatable, Sendable, Codable {
    public var field: String
    public var code: FieldErrorCode
    public init(field: String, code: FieldErrorCode) { self.field = field; self.code = code }
}

public struct ValidationResult: Equatable, Sendable, Codable {
    public var valid: Bool
    public var errors: [FieldError]
    public init(errors: [FieldError]) { self.errors = errors; valid = errors.isEmpty }
}

/// التحقق المشترك من نموذج الرفع الديناميكي، بالدلالات المتفق عليها في `form-conformance`:
/// الرؤية بنوع المادة والشرط؛ المخفي يُتجاهل؛ الفارغ المطلوب ← `required`؛ الطول بنقاط الترميز؛ خطأ واحد لكل حقل بترتيب الحقول.
public enum FormValidator {
    static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])
    static let rfc3339 = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$", options: [.caseInsensitive])

    /// الحقول المرئية بالترتيب: يطابق `material_types` نوعَ المادة، ويتحقق `condition` من قيمة حقل مرئي آخر (`equals` على multi_select = يحتوي).
    public static func visibleFields(form: UploadForm, materialType: String?, values: [String: FormValue]) -> [UploadFormField] {
        var visible: [UploadFormField] = []
        var visibleKeys = Set<String>()
        for f in form.fields {
            if let types = f.materialTypes, !types.isEmpty, !types.contains(where: { $0.rawValue == materialType }) { continue }
            if let cond = f.condition {
                guard visibleKeys.contains(cond.field), let expected = cond.equals.map(FormValue.init) else { continue }
                let actual = values[cond.field] ?? .null
                let met = actual.arrayValue.map { $0.contains(expected) } ?? (actual == expected)
                if !met { continue }
            }
            visible.append(f)
            visibleKeys.insert(f.key)
        }
        return visible
    }

    public static func validate(form: UploadForm, materialType: String?, values: [String: FormValue]) -> ValidationResult {
        var errors: [FieldError] = []
        for f in visibleFields(form: form, materialType: materialType, values: values) {
            if let code = check(f, values[f.key] ?? .null) { errors.append(FieldError(field: f.key, code: code)) }
        }
        return ValidationResult(errors: errors)
    }

    /// أول قاعدة تفشل لحقل مرئي: required ثم type ثم قواعد النوع.
    public static func check(_ field: UploadFormField, _ value: FormValue) -> FieldErrorCode? {
        if value.isEmpty { return field.required ? .required : nil }
        let v = field.validation
        switch field.type {
        case .shortText, .longText:
            guard let s = value.stringValue else { return .type }
            let n = s.unicodeScalars.count
            if let min = v?.minLength, n < min { return .minLength }
            if let max = v?.maxLength, n > max { return .maxLength }
            if let p = v?.pattern, !matches(pattern: p, s) { return .pattern }
            return nil
        case .number:
            guard let d = value.numberValue, d.isFinite else { return .type }
            if let min = v?.min, d < min { return .min }
            if let max = v?.max, d > max { return .max }
            return nil
        case .select:
            guard let s = value.stringValue else { return .type }
            return (v?.options ?? []).contains { $0.value == s } ? nil : .option
        case .multiSelect:
            guard let items = value.arrayValue, items.allSatisfy({ $0.stringValue != nil }) else { return .type }
            if let min = v?.minItems, items.count < min { return .minItems }
            if let max = v?.maxItems, items.count > max { return .maxItems }
            let allowed = Set((v?.options ?? []).map(\.value))
            return items.allSatisfy { allowed.contains($0.stringValue!) } ? nil : .option
        case .datetime:
            guard let s = value.stringValue, let t = instant(s) else { return .type }
            if let nb = v?.notBefore, t < nb { return .notBefore }
            if let na = v?.notAfter, t > na { return .notAfter }
            return nil
        case .boolean:
            return value.boolValue == nil ? .type : nil
        case .staffMember:
            guard let s = value.stringValue, uuid.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return .type }
            return nil
        case .attachment:
            guard let items = value.arrayValue else { return .type }
            var files: [(mime: String, size: Double)] = []
            for item in items {
                guard case .object(let o) = item, let mime = o["mime"]?.stringValue, let size = o["size_bytes"]?.numberValue, size == size.rounded() else { return .type }
                files.append((mime, size))
            }
            if let min = v?.minItems, files.count < min { return .minItems }
            if let max = v?.maxItems, files.count > max { return .maxItems }
            if let accept = v?.accept, files.contains(where: { f in !accept.contains { a in a.hasSuffix("/*") ? f.mime.hasPrefix(String(a.dropLast())) : a == f.mime } }) { return .accept }
            if let maxSize = v?.maxSizeBytes, files.contains(where: { $0.size > Double(maxSize) }) { return .maxSizeBytes }
            return nil
        case .location, .unknownDefaultOpenApi:
            return .type
        }
    }

    /// `pattern` بصيغة ECMA-262؛ يُطابق في أي موضع ما لم يُثبَّت بـ `^…$`.
    static func matches(pattern: String, _ s: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// date-time كامل بصيغة RFC 3339، يُقارن لحظةً زمنية بغض النظر عن الإزاحة.
    static func instant(_ s: String) -> Date? {
        guard rfc3339.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return nil }
        let normalized = s.uppercased()
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: normalized) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: normalized)
    }
}
