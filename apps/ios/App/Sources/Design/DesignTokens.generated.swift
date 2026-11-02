// مولَّد من docs/design/tokens.v2.json بـ apps/ios/scripts/generate-design-tokens.mjs — لا يُعدَّل يدويًا.
import SwiftUI

extension Color {
    /// الألوان الدلالية للهوية v2 بوضعين (فاتح وداكن) من `DesignTokens.xcassets`.
    enum vl {
        /// `bg/base`
        static let bgBase = Color("vl/bg-base")
        /// `bg/raised`
        static let bgRaised = Color("vl/bg-raised")
        /// `bg/sunken`
        static let bgSunken = Color("vl/bg-sunken")
        /// `bg/store`
        static let bgStore = Color("vl/bg-store")
        /// `text/primary`
        static let textPrimary = Color("vl/text-primary")
        /// `text/secondary`
        static let textSecondary = Color("vl/text-secondary")
        /// `text/on-brand`
        static let textOnBrand = Color("vl/text-on-brand")
        /// `text/brand`
        static let textBrand = Color("vl/text-brand")
        /// `text/on-store`
        static let textOnStore = Color("vl/text-on-store")
        /// `border/line`
        static let borderLine = Color("vl/border-line")
        /// `border/edge`
        static let borderEdge = Color("vl/border-edge")
        /// `action/primary`
        static let actionPrimary = Color("vl/action-primary")
        /// `action/gradient-end`
        static let actionGradientEnd = Color("vl/action-gradient-end")
        /// `action/soft`
        static let actionSoft = Color("vl/action-soft")
        /// `action/store`
        static let actionStore = Color("vl/action-store")
        /// `priority/urgent`
        static let priorityUrgent = Color("vl/priority-urgent")
        /// `sensitivity/bg`
        static let sensitivityBg = Color("vl/sensitivity-bg")
        /// `sensitivity/border`
        static let sensitivityBorder = Color("vl/sensitivity-border")
        /// `state/ok`
        static let stateOk = Color("vl/state-ok")
        /// `state/warn`
        static let stateWarn = Color("vl/state-warn")
        /// `state/muted`
        static let stateMuted = Color("vl/state-muted")
        /// `state/brand`
        static let stateBrand = Color("vl/state-brand")
        /// `state/danger`
        static let stateDanger = Color("vl/state-danger")

        // نغمات الحالات الثلاث للمادة (فنية، تحريرية، حقوق)، وكلٌّ يشير إلى state/*.
        /// `material-state/technical/ready` → `stateOk` (جاهزة)
        static var materialTechnicalReady: Color { stateOk }
        /// `material-state/technical/processing` → `stateMuted` (تُعالَج)
        static var materialTechnicalProcessing: Color { stateMuted }
        /// `material-state/technical/failed` → `stateDanger` (فشلت)
        static var materialTechnicalFailed: Color { stateDanger }
        /// `material-state/editorial/review` → `stateWarn` (قيد المراجعة)
        static var materialEditorialReview: Color { stateWarn }
        /// `material-state/editorial/approved` → `stateOk` (معتمدة)
        static var materialEditorialApproved: Color { stateOk }
        /// `material-state/editorial/rejected` → `stateDanger` (مرفوضة)
        static var materialEditorialRejected: Color { stateDanger }
        /// `material-state/rights/internal` → `stateMuted` (داخلي)
        static var materialRightsInternal: Color { stateMuted }
        /// `material-state/rights/listed` → `stateBrand` (للعرض)
        static var materialRightsListed: Color { stateBrand }
        /// `material-state/rights/restricted` → `stateWarn` (مقيّد)
        static var materialRightsRestricted: Color { stateWarn }
    }
}

/// المسافات والزوايا والمقاسات والحدود والحركة كما في الرموز (نقاط من px، وثوانٍ من ms).
enum VL {
    enum Space {
        /// `space.1`
        static let s1: CGFloat = 2
        /// `space.2`
        static let s2: CGFloat = 4
        /// `space.3`
        static let s3: CGFloat = 8
        /// `space.4`
        static let s4: CGFloat = 12
        /// `space.5`
        static let s5: CGFloat = 16
        /// `space.6`
        static let s6: CGFloat = 20
        /// `space.7`
        static let s7: CGFloat = 24
        /// `space.8`
        static let s8: CGFloat = 32
        /// `space.9`
        static let s9: CGFloat = 40
        /// `space.10`
        static let s10: CGFloat = 48
        /// `space.11`
        static let s11: CGFloat = 64
        /// `space.12`
        static let s12: CGFloat = 80
    }
    enum Radius {
        /// `radius.sm`
        static let sm: CGFloat = 14
        /// `radius.chip`
        static let chip: CGFloat = 12
        /// `radius.md`
        static let md: CGFloat = 18
        /// `radius.lg`
        static let lg: CGFloat = 28
        /// `radius.phone`
        static let phone: CGFloat = 44
        /// `radius.full`
        static let full: CGFloat = 999
    }
    enum Size {
        /// `size.touch-min`
        static let touchMin: CGFloat = 44
        /// `size.field-min`
        static let fieldMin: CGFloat = 48
        /// `size.cta-min`
        static let ctaMin: CGFloat = 54
        /// `size.phone-min-width`
        static let phoneMinWidth: CGFloat = 375
    }
    enum Border {
        /// `border.field`
        static let field: CGFloat = 1.5
        /// `border.hairline`
        static let hairline: CGFloat = 1
        /// `border.ring`
        static let ring: CGFloat = 1.4
        /// `border.progress`
        static let progress: CGFloat = 6
    }
    /// تتوقف كلها مع «تقليل الحركة»، والمعنى باقٍ (الرقم والكلمة).
    enum Duration {
        /// `motion.fast`
        static let fast: Double = 0.12
        /// `motion.base`
        static let base: Double = 0.2
        /// `motion.slow`
        static let slow: Double = 0.32
        /// `motion.pulse`
        static let pulse: Double = 2.4
    }
    /// الخط الأول في كل عائلة هو المضمَّن في التطبيق؛ البقية بدائل الويب.
    enum FontFamily {
        /// Rubik, Readex Pro, system-ui, sans-serif
        static let display = "Rubik"
        /// Readex Pro, Noto Sans Arabic, system-ui, sans-serif
        static let text = "Readex Pro"
        /// Rubik, ui-monospace, monospace
        static let num = "Rubik"
    }
}

extension VLTextRole {
    /// `font.role.display`
    static let display = VLTextRole(family: .display, size: 34, lineHeight: 44, weight: 800)
    /// `font.role.title`
    static let title = VLTextRole(family: .display, size: 22, lineHeight: 32, weight: 700)
    /// `font.role.headline`
    static let headline = VLTextRole(family: .text, size: 17, lineHeight: 26, weight: 700)
    /// `font.role.body`
    static let body = VLTextRole(family: .text, size: 16, lineHeight: 26, weight: 400)
    /// `font.role.label`
    static let label = VLTextRole(family: .text, size: 13, lineHeight: 20, weight: 600)
    /// `font.role.caption`
    static let caption = VLTextRole(family: .text, size: 12, lineHeight: 18, weight: 500)
    /// `font.role.num`
    static let num = VLTextRole(family: .num, size: 15, lineHeight: 22, weight: 600)
}
