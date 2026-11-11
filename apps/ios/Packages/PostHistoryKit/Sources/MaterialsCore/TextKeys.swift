import Foundation
import PostHistoryAPI
import UploadCore

// مفاتيح نصوص الواجهة المبنية من قيم التعداد (إصلاح بناء 1.0 (11)). تُبنى `String` هنا ثم تُمرَّر إلى `LocalizedStringKey(_:)` بقيمة
// لا بحرفي: الحرفي المُدرج `LocalizedStringKey("gallery.quick.\(x)")` تحوّله `LocalizedStringKey.StringInterpolation` إلى مفتاح صيغة
// "gallery.quick.%@" لا وجود له في الكتالوج، فيظهر المفتاح نفسه على الشاشة. كل قيمة لها مفتاحها في `Localizable.xcstrings` بالعربية
// والإنجليزية (`TextKeys.all`، مختبر)، وحرفي مُدرج في `LocalizedStringKey(`/`Text(` يُرفض في اختبار يقرأ مصادر التطبيق.

extension GalleryQuickFilter {
    public var textKey: String { "gallery.quick." + rawValue }
}

extension MediaKind {
    public var textKey: String { "gallery.kind." + rawValue }
}

extension GalleryGrouping {
    public var textKey: String { "gallery.grouping." + rawValue }
}

extension GalleryDateRange {
    public var textKey: String { "gallery.date." + rawValue }
}

extension GalleryStateFilter {
    public var textKey: String { "gallery.state." + rawValue }
}

extension MaterialStatus.Track {
    /// عنوان المسار في تفاصيل المادة.
    public var detailKey: String { "detail.track." + rawValue }
}

extension MaterialType {
    /// اسم نوع التغطية؛ نوع لا يعرفه هذا الإصدار من العقد («غير معروف») له مفتاحه، فلا يظهر مفتاح خام.
    public var textKey: String {
        self == .unknownDefaultOpenApi ? "material.type.unknown" : "material.type." + rawValue
    }
}

extension UploadFailure {
    /// سبب فشل الرفع بكلماته في شاشة الرفع. «الحساب لا يرفع» (`notPermitted`، `403 forbidden_role`) غير «تعذّر إثبات الجهاز»
    /// (`deviceNotAttested`، `attestation_failed`)، ولكلٍّ نصّه.
    public var textKey: String {
        switch self {
        case .checksumMismatch: return "upload.failure.checksumMismatch"
        case .invalidFile: return "upload.failure.invalidFile"
        case .expired: return "upload.failure.expired"
        case .aborted: return "upload.failure.aborted"
        case .storageError: return "upload.failure.storageError"
        case .sourceMissing: return "upload.failure.sourceMissing"
        case .rejected: return "upload.failure.rejected"
        case .deviceNotAttested: return "upload.failure.deviceNotAttested"
        case .notPermitted: return "upload.failure.notPermitted"
        }
    }
}

public enum TextKeys {
    /// كل مفتاح تبنيه الواجهة من قيمة تعداد؛ يُفحص وجوده في الكتالوج بالعربية والإنجليزية.
    public static var all: [String] {
        let screens: [String] = GalleryQuickFilter.allCases.map(\.textKey) + MediaKind.allCases.map(\.textKey)
            + GalleryGrouping.allCases.map(\.textKey) + GalleryDateRange.allCases.map(\.textKey)
            + GalleryStateFilter.allCases.map(\.textKey) + MaterialStatus.Track.allCases.map(\.detailKey)
            + MaterialType.allCases.map(\.textKey) + UploadFailure.allCases.map(\.textKey) + SendAccess.textKeys
        let announcements: [String] = UploadAnnouncement.allCases.map(\.textKey)
        return screens + announcements
    }
}
