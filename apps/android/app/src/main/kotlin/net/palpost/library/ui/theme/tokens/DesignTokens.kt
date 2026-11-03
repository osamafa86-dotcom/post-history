// Generated from docs/design/tokens.v2.json by apps/android/scripts/generate-design-tokens.mjs. Do not edit.
package net.palpost.library.ui.theme.tokens

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The semantic colours of identity v2 (`color.{bg,text,border,action,priority,sensitivity,state}.*`); one instance per mode. */
data class VlColors(
    /** `bg/base` */
    val bgBase: Color,
    /** `bg/raised` */
    val bgRaised: Color,
    /** `bg/sunken` */
    val bgSunken: Color,
    /** `bg/store` */
    val bgStore: Color,
    /** `text/primary` */
    val textPrimary: Color,
    /** `text/secondary` */
    val textSecondary: Color,
    /** `text/on-brand` */
    val textOnBrand: Color,
    /** `text/brand` */
    val textBrand: Color,
    /** `text/on-store` */
    val textOnStore: Color,
    /** `border/line` */
    val borderLine: Color,
    /** `border/edge` */
    val borderEdge: Color,
    /** `action/primary` */
    val actionPrimary: Color,
    /** `action/gradient-end` */
    val actionGradientEnd: Color,
    /** `action/soft` */
    val actionSoft: Color,
    /** `action/store` */
    val actionStore: Color,
    /** `priority/urgent` */
    val priorityUrgent: Color,
    /** `sensitivity/bg` */
    val sensitivityBg: Color,
    /** `sensitivity/border` */
    val sensitivityBorder: Color,
    /** `state/ok` */
    val stateOk: Color,
    /** `state/warn` */
    val stateWarn: Color,
    /** `state/muted` */
    val stateMuted: Color,
    /** `state/brand` */
    val stateBrand: Color,
    /** `state/danger` */
    val stateDanger: Color,
) {
    // The three tracks' tones (technical, editorial, rights): each points at a state/* colour.
    /** `material-state/technical/ready` → `stateOk` */
    val materialTechnicalReady: Color get() = stateOk
    /** `material-state/technical/processing` → `stateMuted` */
    val materialTechnicalProcessing: Color get() = stateMuted
    /** `material-state/technical/failed` → `stateDanger` */
    val materialTechnicalFailed: Color get() = stateDanger
    /** `material-state/editorial/review` → `stateWarn` */
    val materialEditorialReview: Color get() = stateWarn
    /** `material-state/editorial/approved` → `stateOk` */
    val materialEditorialApproved: Color get() = stateOk
    /** `material-state/editorial/rejected` → `stateDanger` */
    val materialEditorialRejected: Color get() = stateDanger
    /** `material-state/rights/internal` → `stateMuted` */
    val materialRightsInternal: Color get() = stateMuted
    /** `material-state/rights/listed` → `stateBrand` */
    val materialRightsListed: Color get() = stateBrand
    /** `material-state/rights/restricted` → `stateWarn` */
    val materialRightsRestricted: Color get() = stateWarn
}

val VlLightColors = VlColors(
    bgBase = Color(0xFFF4F6F9),
    bgRaised = Color(0xFFFFFFFF),
    bgSunken = Color(0xFFE9EDF3),
    bgStore = Color(0xFF0D1524),
    textPrimary = Color(0xFF0D1524),
    textSecondary = Color(0xFF55617A),
    textOnBrand = Color(0xFFFFFFFF),
    textBrand = Color(0xFF08717E),
    textOnStore = Color(0xFFEDF1F7),
    borderLine = Color(0xFFDCE2EA),
    borderEdge = Color(0xFF6E7B93),
    actionPrimary = Color(0xFF08717E),
    actionGradientEnd = Color(0xFF2E56E8),
    actionSoft = Color(0xFFE0F1F4),
    actionStore = Color(0xFFD0A030),
    priorityUrgent = Color(0xFFC8312B),
    sensitivityBg = Color(0xFFF5E6B8),
    sensitivityBorder = Color(0xFF8A6200),
    stateOk = Color(0xFF18764E),
    stateWarn = Color(0xFF8A6200),
    stateMuted = Color(0xFF55617A),
    stateBrand = Color(0xFF08717E),
    stateDanger = Color(0xFFC8312B),
)

val VlDarkColors = VlColors(
    bgBase = Color(0xFF090D15),
    bgRaised = Color(0xFF121A28),
    bgSunken = Color(0xFF060910),
    bgStore = Color(0xFF0D1524),
    textPrimary = Color(0xFFEDF1F7),
    textSecondary = Color(0xFF96A2B8),
    textOnBrand = Color(0xFF0A1F26),
    textBrand = Color(0xFF42CFDF),
    textOnStore = Color(0xFFEDF1F7),
    borderLine = Color(0xFF232C3D),
    borderEdge = Color(0xFF6E7B93),
    actionPrimary = Color(0xFF42CFDF),
    actionGradientEnd = Color(0xFF8A9DFF),
    actionSoft = Color(0xFF10303A),
    actionStore = Color(0xFFD0A030),
    priorityUrgent = Color(0xFFFF6A60),
    sensitivityBg = Color(0xFF3D3110),
    sensitivityBorder = Color(0xFFE9B649),
    stateOk = Color(0xFF4FD69B),
    stateWarn = Color(0xFFE9B649),
    stateMuted = Color(0xFF96A2B8),
    stateBrand = Color(0xFF42CFDF),
    stateDanger = Color(0xFFFF6A60),
)

/** `space.*` in dp (from px). */
object VlSpace {
    /** `space.1` */
    val s1 = 2.dp
    /** `space.2` */
    val s2 = 4.dp
    /** `space.3` */
    val s3 = 8.dp
    /** `space.4` */
    val s4 = 12.dp
    /** `space.5` */
    val s5 = 16.dp
    /** `space.6` */
    val s6 = 20.dp
    /** `space.7` */
    val s7 = 24.dp
    /** `space.8` */
    val s8 = 32.dp
    /** `space.9` */
    val s9 = 40.dp
    /** `space.10` */
    val s10 = 48.dp
    /** `space.11` */
    val s11 = 64.dp
    /** `space.12` */
    val s12 = 80.dp
}

/** `radius.*` in dp (from px). */
object VlRadius {
    /** `radius.sm` */
    val sm = 14.dp
    /** `radius.chip` */
    val chip = 12.dp
    /** `radius.md` */
    val md = 18.dp
    /** `radius.lg` */
    val lg = 28.dp
    /** `radius.phone` */
    val phone = 44.dp
    /** `radius.full` */
    val full = 999.dp
}

/** `size.*` in dp (from px). */
object VlSize {
    /** `size.touch-min` */
    val touchMin = 44.dp
    /** `size.field-min` */
    val fieldMin = 48.dp
    /** `size.cta-min` */
    val ctaMin = 54.dp
    /** `size.phone-min-width` */
    val phoneMinWidth = 375.dp
}

/** `border.*` in dp (from px). */
object VlBorder {
    /** `border.field` */
    val field = 1.5f.dp
    /** `border.hairline` */
    val hairline = 1.dp
    /** `border.ring` */
    val ring = 1.4f.dp
    /** `border.progress` */
    val progress = 6.dp
}

/** `motion.*`; every animation stops with the system's "remove animations", the meaning stays (number and word). */
object VlMotion {
    /** `motion.fast` */
    const val fastMs = 120
    /** `motion.base` */
    const val baseMs = 200
    /** `motion.slow` */
    const val slowMs = 320
    /** `motion.pulse` */
    const val pulseMs = 2400
}

/** `font.family.*`: DISPLAY (Rubik), TEXT (Readex Pro), NUM (Rubik with tabular figures). */
enum class VlFontKind { DISPLAY, TEXT, NUM }

data class VlTypeRole(val size: TextUnit, val lineHeight: TextUnit, val weight: FontWeight, val kind: VlFontKind)

/** `font.role.*` */
object VlType {
    /** `font.role.display` */
    val display = VlTypeRole(34.sp, 44.sp, FontWeight(800), VlFontKind.DISPLAY)
    /** `font.role.title` */
    val title = VlTypeRole(22.sp, 32.sp, FontWeight(700), VlFontKind.DISPLAY)
    /** `font.role.headline` */
    val headline = VlTypeRole(17.sp, 26.sp, FontWeight(700), VlFontKind.TEXT)
    /** `font.role.body` */
    val body = VlTypeRole(16.sp, 26.sp, FontWeight(400), VlFontKind.TEXT)
    /** `font.role.label` */
    val label = VlTypeRole(13.sp, 20.sp, FontWeight(600), VlFontKind.TEXT)
    /** `font.role.caption` */
    val caption = VlTypeRole(12.sp, 18.sp, FontWeight(500), VlFontKind.TEXT)
    /** `font.role.num` */
    val num = VlTypeRole(15.sp, 22.sp, FontWeight(600), VlFontKind.NUM)
}
