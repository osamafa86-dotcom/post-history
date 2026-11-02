import SwiftUI

/// دور خط من الهوية v2 (design-system-v2.md «الخط»؛ ADR 0088): العائلة والحجم والسطر والوزن بالنقاط.
/// الأدوار نفسها مولَّدة في `DesignTokens.generated.swift` من `tokens.v2.json`؛ هنا شكلها وتحويلها إلى خط.
struct VLTextRole: Sendable {
    /// `display` Rubik للعناوين الكبيرة، و`text` Readex Pro للنص، و`num` Rubik بأرقام جدولية لكل رقم يُصطفّ
    /// (عدّاد، مدة، نسبة، حجم)، و`mono` IBM Plex Mono لرقم الإيصال والبصمة وحدهما (ليسا في الرموز؛ ADR 0088).
    enum Family: Sendable { case display, text, num, mono }
    let family: Family
    let size: CGFloat
    let lineHeight: CGFloat
    let weight: Int

    /// رقم الإيصال والبصمة: خط أحادي بمقاس دور الأرقام كي لا يلتبس حرف برقم عند قراءته على الهاتف.
    static let receipt = VLTextRole(family: .mono, size: 15, lineHeight: 22, weight: 500)
    /// الزرّ الكبير: نص 17 Bold كما في مكوّن Button (design-system-v2.md «المكوّنات»).
    static let button = VLTextRole(family: .text, size: 17, lineHeight: 24, weight: 700)
    /// نسبة الرفع في وسط دوائر البثّ.
    static let bigNumber = VLTextRole(family: .num, size: 30, lineHeight: 34, weight: 700)
    /// نص الرقاقة (`Chip`) بحجم ثابت بين الحالتين، والمحدَّدة أثقل وزنًا كي لا يتغيّر عرضها بغير الوزن.
    static let chip = VLTextRole(family: .text, size: 15, lineHeight: 22, weight: 500)
    static let chipSelected = VLTextRole(family: .text, size: 15, lineHeight: 22, weight: 700)
}

extension VLTextRole {
    /// الحجم يتبع حجم الخط الديناميكي للنظام نسبةً إلى نمط نص مقارب، حتى أحجام الوصولية.
    var font: Font {
        let base = Font.custom(postScriptName, size: size, relativeTo: textStyle)
        // Readex Pro بلا `tnum`؛ الأرقام المصطفّة بخط Rubik الذي يحملها.
        return family == .num ? base.monospacedDigit() : base
    }

    /// المسافة الإضافية بين السطور حتى يقارب ارتفاع السطر ما في الرموز (SwiftUI يضيفها فوق ارتفاع الخط الطبيعي).
    var extraLineSpacing: CGFloat { max(0, lineHeight - size * 1.25) }

    /// الأسماء كما في جدول `name` لملفات الخطوط المضمَّنة (أوزان ثابتة لا متغيّرة).
    var postScriptName: String {
        switch family {
        case .mono:
            return "IBMPlexMono-Medium"
        case .display, .num:
            switch weight {
            case ..<700: return "Rubik-SemiBold"
            case 700: return "Rubik-Bold"
            default: return "Rubik-ExtraBold"
            }
        case .text:
            switch weight {
            case ..<500: return "ReadexPro-Regular"
            case 500: return "ReadexPro-Medium"
            case 600: return "ReadexPro-SemiBold"
            default: return "ReadexPro-Bold"
            }
        }
    }

    private var textStyle: Font.TextStyle {
        switch size {
        case 30...: return .largeTitle
        case 22..<30: return .title2
        case 18..<22: return .title3
        case 17..<18: return .headline
        case 16..<17: return .body
        case 14..<16: return .subheadline
        case 13..<14: return .footnote
        default: return .caption
        }
    }
}

private struct VLTextModifier: ViewModifier {
    let role: VLTextRole

    func body(content: Content) -> some View {
        content.font(role.font).lineSpacing(role.extraLineSpacing)
    }
}

extension View {
    /// نص بدور من الهوية v2: `.vlText(.body)`.
    func vlText(_ role: VLTextRole) -> some View { modifier(VLTextModifier(role: role)) }
}
