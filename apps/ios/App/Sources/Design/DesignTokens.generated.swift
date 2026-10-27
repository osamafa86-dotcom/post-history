// مولَّد من docs/design/tokens.json بـ apps/ios/scripts/generate-design-tokens.mjs — لا يُعدَّل يدويًا.
import SwiftUI

extension Color {
    /// الألوان الدلالية بوضعين (فاتح وداكن) من `DesignTokens.xcassets`.
    enum vl {
        /// `bg/canvas`
        static let bgCanvas = Color("vl/bg-canvas")
        /// `bg/surface`
        static let bgSurface = Color("vl/bg-surface")
        /// `bg/surface-raised`
        static let bgSurfaceRaised = Color("vl/bg-surface-raised")
        /// `bg/subtle`
        static let bgSubtle = Color("vl/bg-subtle")
        /// `bg/sunken`
        static let bgSunken = Color("vl/bg-sunken")
        /// `bg/brand`
        static let bgBrand = Color("vl/bg-brand")
        /// `bg/brand-hover`
        static let bgBrandHover = Color("vl/bg-brand-hover")
        /// `bg/brand-subtle`
        static let bgBrandSubtle = Color("vl/bg-brand-subtle")
        /// `bg/inverse`
        static let bgInverse = Color("vl/bg-inverse")
        /// `bg/danger`
        static let bgDanger = Color("vl/bg-danger")
        /// `bg/danger-subtle`
        static let bgDangerSubtle = Color("vl/bg-danger-subtle")
        /// `bg/disabled`
        static let bgDisabled = Color("vl/bg-disabled")
        /// `bg/media`
        static let bgMedia = Color("vl/bg-media")
        /// `bg/slate`
        static let bgSlate = Color("vl/bg-slate")
        /// `text/primary`
        static let textPrimary = Color("vl/text-primary")
        /// `text/secondary`
        static let textSecondary = Color("vl/text-secondary")
        /// `text/muted`
        static let textMuted = Color("vl/text-muted")
        /// `text/on-brand`
        static let textOnBrand = Color("vl/text-on-brand")
        /// `text/brand`
        static let textBrand = Color("vl/text-brand")
        /// `text/inverse`
        static let textInverse = Color("vl/text-inverse")
        /// `text/danger`
        static let textDanger = Color("vl/text-danger")
        /// `text/disabled`
        static let textDisabled = Color("vl/text-disabled")
        /// `text/on-media`
        static let textOnMedia = Color("vl/text-on-media")
        /// `text/on-slate`
        static let textOnSlate = Color("vl/text-on-slate")
        /// `border/default`
        static let borderDefault = Color("vl/border-default")
        /// `border/strong`
        static let borderStrong = Color("vl/border-strong")
        /// `border/brand`
        static let borderBrand = Color("vl/border-brand")
        /// `border/danger`
        static let borderDanger = Color("vl/border-danger")
        /// `border/focus`
        static let borderFocus = Color("vl/border-focus")
        /// `border/on-slate`
        static let borderOnSlate = Color("vl/border-on-slate")
        /// `icon/default`
        static let iconDefault = Color("vl/icon-default")
        /// `icon/muted`
        static let iconMuted = Color("vl/icon-muted")
        /// `icon/brand`
        static let iconBrand = Color("vl/icon-brand")
        /// `icon/on-brand`
        static let iconOnBrand = Color("vl/icon-on-brand")
        /// `tone/neutral/bg`
        static let toneNeutralBg = Color("vl/tone-neutral-bg")
        /// `tone/neutral/fg`
        static let toneNeutralFg = Color("vl/tone-neutral-fg")
        /// `tone/neutral/border`
        static let toneNeutralBorder = Color("vl/tone-neutral-border")
        /// `tone/progress/bg`
        static let toneProgressBg = Color("vl/tone-progress-bg")
        /// `tone/progress/fg`
        static let toneProgressFg = Color("vl/tone-progress-fg")
        /// `tone/progress/border`
        static let toneProgressBorder = Color("vl/tone-progress-border")
        /// `tone/good/bg`
        static let toneGoodBg = Color("vl/tone-good-bg")
        /// `tone/good/fg`
        static let toneGoodFg = Color("vl/tone-good-fg")
        /// `tone/good/border`
        static let toneGoodBorder = Color("vl/tone-good-border")
        /// `tone/attention/bg`
        static let toneAttentionBg = Color("vl/tone-attention-bg")
        /// `tone/attention/fg`
        static let toneAttentionFg = Color("vl/tone-attention-fg")
        /// `tone/attention/border`
        static let toneAttentionBorder = Color("vl/tone-attention-border")
        /// `tone/bad/bg`
        static let toneBadBg = Color("vl/tone-bad-bg")
        /// `tone/bad/fg`
        static let toneBadFg = Color("vl/tone-bad-fg")
        /// `tone/bad/border`
        static let toneBadBorder = Color("vl/tone-bad-border")
        /// `tone/urgent/bg`
        static let toneUrgentBg = Color("vl/tone-urgent-bg")
        /// `tone/urgent/fg`
        static let toneUrgentFg = Color("vl/tone-urgent-fg")
        /// `tone/urgent/border`
        static let toneUrgentBorder = Color("vl/tone-urgent-border")
        /// `track/technical/accent`
        static let trackTechnicalAccent = Color("vl/track-technical-accent")
        /// `track/technical/subtle`
        static let trackTechnicalSubtle = Color("vl/track-technical-subtle")
        /// `track/editorial/accent`
        static let trackEditorialAccent = Color("vl/track-editorial-accent")
        /// `track/editorial/subtle`
        static let trackEditorialSubtle = Color("vl/track-editorial-subtle")
        /// `track/rights/accent`
        static let trackRightsAccent = Color("vl/track-rights-accent")
        /// `track/rights/subtle`
        static let trackRightsSubtle = Color("vl/track-rights-subtle")
        /// `track/state/done`
        static let trackStateDone = Color("vl/track-state-done")
        /// `track/state/progress`
        static let trackStateProgress = Color("vl/track-state-progress")
        /// `track/state/attention`
        static let trackStateAttention = Color("vl/track-state-attention")
        /// `track/state/blocked`
        static let trackStateBlocked = Color("vl/track-state-blocked")
        /// `track/state/empty`
        static let trackStateEmpty = Color("vl/track-state-empty")
    }
}

/// المسافات والزوايا والمقاسات والحدود ونقاط الشاشة كما في الرموز.
enum VL {
    enum Space {
        /// `space.0`
        static let s0: CGFloat = 0
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
        /// `radius.none`
        static let none: CGFloat = 0
        /// `radius.sm`
        static let sm: CGFloat = 4
        /// `radius.md`
        static let md: CGFloat = 8
        /// `radius.lg`
        static let lg: CGFloat = 12
        /// `radius.xl`
        static let xl: CGFloat = 16
        /// `radius.2xl`
        static let r2xl: CGFloat = 24
        /// `radius.full`
        static let full: CGFloat = 999
    }
    enum Size {
        /// `size.touch-min`
        static let touchMin: CGFloat = 44
        /// `size.touch-compact`
        static let touchCompact: CGFloat = 36
        /// `size.control-sm`
        static let controlSm: CGFloat = 36
        /// `size.control-md`
        static let controlMd: CGFloat = 44
        /// `size.control-lg`
        static let controlLg: CGFloat = 52
        /// `size.icon-sm`
        static let iconSm: CGFloat = 16
        /// `size.icon-md`
        static let iconMd: CGFloat = 20
        /// `size.icon-lg`
        static let iconLg: CGFloat = 24
        /// `size.avatar-sm`
        static let avatarSm: CGFloat = 32
        /// `size.avatar-md`
        static let avatarMd: CGFloat = 40
        /// `size.thumb-w`
        static let thumbW: CGFloat = 160
        /// `size.thumb-h`
        static let thumbH: CGFloat = 90
        /// `size.sidebar-w`
        static let sidebarW: CGFloat = 240
        /// `size.content-max`
        static let contentMax: CGFloat = 1440
        /// `size.board-card-min`
        static let boardCardMin: CGFloat = 280
    }
    enum Border {
        /// `border.hairline`
        static let hairline: CGFloat = 1
        /// `border.regular`
        static let regular: CGFloat = 2
        /// `border.emphasis`
        static let emphasis: CGFloat = 3
    }
    enum Duration {
        /// `motion.duration.fast`
        static let fast: Double = 0.12
        /// `motion.duration.base`
        static let base: Double = 0.2
        /// `motion.duration.slow`
        static let slow: Double = 0.32
        /// `motion.duration.progress`
        static let progress: Double = 0.6
    }
    enum Easing {
        /// `motion.easing.standard`
        static func standard(_ duration: Double) -> Animation { .timingCurve(0.2, 0, 0, 1, duration: duration) }
        /// `motion.easing.emphasized`
        static func emphasized(_ duration: Double) -> Animation { .timingCurve(0.3, 0, 0, 1, duration: duration) }
        /// `motion.easing.linear`
        static func linear(_ duration: Double) -> Animation { .linear(duration: duration) }
    }
    enum FontFamily {
        static let arabic = "Vazirmatn"
        static let display = "Reem Kufi"
        static let latin = "Vazirmatn"
        static let mono = "IBM Plex Mono"
    }
}

/// أدوار الخط: العائلة (نص، أو عرض للعناوين الكبيرة، أو أحادي)، والحجم والسطر والوزن بالنقاط.
struct VLTextRole: Sendable {
    enum Family: Sendable { case text, display, mono }
    let family: Family
    let size: CGFloat
    let lineHeight: CGFloat
    let weight: Int

    /// `font.role.display/xl`
    static let displayXl = VLTextRole(family: .display, size: 64, lineHeight: 76, weight: 700)
    /// `font.role.display/lg`
    static let displayLg = VLTextRole(family: .display, size: 48, lineHeight: 58, weight: 700)
    /// `font.role.display/md`
    static let displayMd = VLTextRole(family: .display, size: 40, lineHeight: 48, weight: 700)
    /// `font.role.heading/h1`
    static let headingH1 = VLTextRole(family: .display, size: 32, lineHeight: 40, weight: 700)
    /// `font.role.heading/h2`
    static let headingH2 = VLTextRole(family: .text, size: 24, lineHeight: 34, weight: 700)
    /// `font.role.heading/h3`
    static let headingH3 = VLTextRole(family: .text, size: 20, lineHeight: 30, weight: 600)
    /// `font.role.heading/h4`
    static let headingH4 = VLTextRole(family: .text, size: 18, lineHeight: 28, weight: 600)
    /// `font.role.body/lg`
    static let bodyLg = VLTextRole(family: .text, size: 18, lineHeight: 30, weight: 400)
    /// `font.role.body/md`
    static let bodyMd = VLTextRole(family: .text, size: 16, lineHeight: 26, weight: 400)
    /// `font.role.body/sm`
    static let bodySm = VLTextRole(family: .text, size: 14, lineHeight: 22, weight: 400)
    /// `font.role.label/lg`
    static let labelLg = VLTextRole(family: .text, size: 16, lineHeight: 24, weight: 500)
    /// `font.role.label/md`
    static let labelMd = VLTextRole(family: .text, size: 14, lineHeight: 20, weight: 500)
    /// `font.role.label/sm`
    static let labelSm = VLTextRole(family: .text, size: 12, lineHeight: 16, weight: 500)
    /// `font.role.caption/md`
    static let captionMd = VLTextRole(family: .text, size: 12, lineHeight: 18, weight: 400)
    /// `font.role.overline/md`
    static let overlineMd = VLTextRole(family: .text, size: 12, lineHeight: 16, weight: 500)
    /// `font.role.board/number`
    static let boardNumber = VLTextRole(family: .display, size: 96, lineHeight: 104, weight: 700)
    /// `font.role.board/title`
    static let boardTitle = VLTextRole(family: .display, size: 32, lineHeight: 40, weight: 700)
    /// `font.role.board/card`
    static let boardCard = VLTextRole(family: .text, size: 32, lineHeight: 40, weight: 600)
    /// `font.role.board/meta`
    static let boardMeta = VLTextRole(family: .text, size: 24, lineHeight: 32, weight: 500)
    /// `font.role.mono/md`
    static let monoMd = VLTextRole(family: .mono, size: 14, lineHeight: 20, weight: 400)
    /// `font.role.mono/lg`
    static let monoLg = VLTextRole(family: .mono, size: 18, lineHeight: 24, weight: 500)
}
