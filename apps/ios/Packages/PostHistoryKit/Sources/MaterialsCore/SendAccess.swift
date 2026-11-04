import Foundation
import PostHistoryAPI

/// من يرسل من التطبيق (الخطة؛ ADR 0011 و0088): حسابات المراسلين وحدها. تحدي الشهادة ورمز البوابة `@Roles('reporter')` على الخادم،
/// فحساب بلا دور مراسل (مشرف، منتج، رئيس تحرير…) كان يختار ملفًا ويرسله ثم يُرفض رفعه عند 0% (بناء TestFlight 13). الأدوار من
/// `GET /auth/me`، وقبل وصوله من الجلسة المحفوظة (أدوارها من الخادم عند الدخول والتحديث)، فلا يُعرض الإرسال لغير المراسل ولو بلا شبكة.
public enum SendAccess: Equatable, Sendable {
    /// الحساب مراسل: شاشة الإرسال ومسوداته.
    case reporter
    /// لا دور مراسل: لا شاشة إرسال، بل سطر بكلمات لا تقنية (`notReporterKey`) عند مدخل الإرسال وفي «موادي».
    case notReporter

    public init(roles: [RoleName]) {
        self = roles.contains(.reporter) ? .reporter : .notReporter
    }

    public var canSend: Bool { self == .reporter }

    /// «هذا الحساب لا يرفع مواد؛ الرفع من التطبيق لحسابات المراسلين.»
    public static let notReporterKey = "send.notReporter"
    /// عنوان الحالة نفسها في «موادي» الفارغة.
    public static let notReporterTitleKey = "send.notReporter.title"

    public static var textKeys: [String] { [notReporterKey, notReporterTitleKey] }
}
