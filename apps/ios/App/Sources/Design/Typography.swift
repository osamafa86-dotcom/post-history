import SwiftUI

/// أدوار الخط من الرموز (`VLTextRole`) بخطوط نظام التصميم: Noto Sans Arabic للعربية، Inter للإنجليزية، IBM Plex Mono
/// للأرقام والإيصالات. الحجم يتبع حجم الخط الديناميكي للنظام نسبةً إلى نمط نص مقارب.
extension VLTextRole {
    func font(arabic: Bool) -> Font {
        .custom(postScriptName(arabic: arabic), size: size, relativeTo: textStyle)
    }

    /// المسافة الإضافية بين السطور حتى يقارب ارتفاع السطر ما في الرموز (SwiftUI يضيفها فوق ارتفاع الخط الطبيعي).
    var extraLineSpacing: CGFloat { max(0, lineHeight - size * 1.25) }

    func postScriptName(arabic: Bool) -> String {
        switch family {
        case .mono:
            return weight >= 500 ? "IBMPlexMono-Medium" : "IBMPlexMono-Regular"
        case .text:
            let base = arabic ? "NotoSansArabic" : "Inter"
            switch weight {
            case ..<500: return "\(base)-Regular"
            case 500: return "\(base)-Medium"
            case 600: return "\(base)-SemiBold"
            default: return "\(base)-Bold"
            }
        }
    }

    private var textStyle: Font.TextStyle {
        switch size {
        case 32...: return .largeTitle
        case 24..<32: return .title
        case 20..<24: return .title2
        case 18..<20: return .title3
        case 16..<18: return .body
        case 14..<16: return .subheadline
        default: return .caption
        }
    }
}

private struct VLTextModifier: ViewModifier {
    @Environment(\.locale) private var locale
    let role: VLTextRole

    func body(content: Content) -> some View {
        let arabic = (locale.language.languageCode?.identifier ?? "ar") == "ar"
        content.font(role.font(arabic: arabic)).lineSpacing(role.extraLineSpacing)
    }
}

extension View {
    /// نص بدور من نظام التصميم: `.vlText(.bodyMd)`.
    func vlText(_ role: VLTextRole) -> some View { modifier(VLTextModifier(role: role)) }
}
