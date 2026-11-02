import Foundation

/// صياغة الأرقام كما في إطارات v2: أرقام لاتينية تُعرض LTR بخط Rubik الجدولي (العدّاد والنسبة والحجم والوقت والإيصال)،
/// فلا يختلط شكلان للأرقام في الشاشة الواحدة. النصوص حولها مترجمة في `Localizable.xcstrings`.
enum VLFormat {
    private static let latin = Locale(identifier: "en_US_POSIX")

    /// «412 MB».
    static func bytes(_ count: Int64) -> String {
        count.formatted(.byteCount(style: .file).locale(latin))
    }

    /// «64%».
    static func percent(_ fraction: Double) -> String {
        "\(Int((min(max(fraction, 0), 1) * 100).rounded()))%"
    }

    /// «14:32» لليوم، و«2026-11-02 14:32» لغيره.
    static func time(_ date: Date, now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = latin
        formatter.timeZone = .current
        formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "HH:mm" : "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    /// «1 نوفمبر 2026» / «November 1, 2026» بلغة التطبيق وأرقام لاتينية (يوم مجموعة في «موادي»، وتاريخ التصوير).
    static func day(_ date: Date) -> String {
        let formatter = DateFormatter()
        let english = Bundle.main.preferredLocalizations.first?.hasPrefix("en") == true
        formatter.locale = Locale(identifier: english ? "en_US" : "ar@numbers=latn")
        formatter.timeZone = .current
        formatter.setLocalizedDateFormatFromTemplate("d MMMM y")
        return formatter.string(from: date)
    }

    /// «3:05» أو «1:02:05».
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "" }
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
