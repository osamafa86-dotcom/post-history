package net.palpost.library.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import net.palpost.library.R
import net.palpost.library.ui.theme.tokens.VlColors
import net.palpost.library.ui.theme.tokens.VlDarkColors
import net.palpost.library.ui.theme.tokens.VlFontKind
import net.palpost.library.ui.theme.tokens.VlLightColors
import net.palpost.library.ui.theme.tokens.VlType
import net.palpost.library.ui.theme.tokens.VlTypeRole

/**
 * Identity v2 «Signal» (ADR 0085, design-system-v2.md) on Compose. Colours, spacing and type roles come from the generated
 * tokens (`ui/theme/tokens/DesignTokens.kt`, from docs/design/tokens.v2.json), never from literals. Light is the base, and
 * dark follows the phone. Rubik draws titles and aligned numbers, Readex Pro the text, and IBM Plex Mono the receipt number
 * and the digest alone (ADR 0088), all bundled so they work offline (docs/fonts.md).
 */
private val Rubik = FontFamily(
    Font(R.font.rubik_600, FontWeight.SemiBold),
    Font(R.font.rubik_700, FontWeight.Bold),
    Font(R.font.rubik_800, FontWeight.ExtraBold),
)
private val ReadexPro = FontFamily(
    Font(R.font.readex_pro_400, FontWeight.Normal),
    Font(R.font.readex_pro_500, FontWeight.Medium),
    Font(R.font.readex_pro_600, FontWeight.SemiBold),
    Font(R.font.readex_pro_700, FontWeight.Bold),
)
private val IbmPlexMono = FontFamily(Font(R.font.ibm_plex_mono_500, FontWeight.Medium))

/**
 * Roles the tokens do not carry, from the component table (design-system-v2.md «المكوّنات»), as on iOS (ADR 0088):
 * the big button, a chip's text (one size whether selected or not, so its width does not jump), the percentage in the
 * broadcast rings, the small action of a dialog, and the receipt number and digest in the mono face.
 */
object VlExtraType {
    val button = VlTypeRole(17.sp, 24.sp, FontWeight.Bold, VlFontKind.TEXT)
    val chip = VlTypeRole(15.sp, 22.sp, FontWeight.Medium, VlFontKind.TEXT)
    val chipSelected = VlTypeRole(15.sp, 22.sp, FontWeight.Bold, VlFontKind.TEXT)
    val action = VlTypeRole(15.sp, 22.sp, FontWeight.SemiBold, VlFontKind.TEXT)
    val bigNumber = VlTypeRole(30.sp, 34.sp, FontWeight.Bold, VlFontKind.NUM)
}

/** The type roles as text styles, each in its role's family; numbers in Rubik use tabular figures. */
class VlTextStyles {
    fun of(role: VlTypeRole): TextStyle = TextStyle(
        fontFamily = when (role.kind) { VlFontKind.TEXT -> ReadexPro; VlFontKind.DISPLAY, VlFontKind.NUM -> Rubik },
        fontSize = role.size, lineHeight = role.lineHeight, fontWeight = role.weight,
        fontFeatureSettings = if (role.kind == VlFontKind.NUM) "tnum" else null,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )
    val display = of(VlType.display)
    val title = of(VlType.title)
    val headline = of(VlType.headline)
    val body = of(VlType.body)
    val label = of(VlType.label)
    val caption = of(VlType.caption)
    val num = of(VlType.num)
    val button = of(VlExtraType.button)
    val chip = of(VlExtraType.chip)
    val chipSelected = of(VlExtraType.chipSelected)
    val action = of(VlExtraType.action)
    val bigNumber = of(VlExtraType.bigNumber)
    /** The receipt number and the digest: mono, at the size of the `num` role. */
    val receipt = TextStyle(fontFamily = IbmPlexMono, fontSize = VlType.num.size, lineHeight = VlType.num.lineHeight, fontWeight = FontWeight.Medium)
}

/** Easings of the motion tokens' animations (the durations are `VlMotion.*Ms`). */
object VlEasing {
    val standard: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val linear: Easing = LinearEasing
}

/** Icon sizes of the component table; not tokens, one place for all screens. */
object VlIcon {
    val sm = 16.dp
    val md = 22.dp
    val lg = 32.dp
}

private val LocalVlColors = staticCompositionLocalOf { VlLightColors }
private val LocalVlText = staticCompositionLocalOf { VlTextStyles() }
private val LocalVlDark = staticCompositionLocalOf { false }

/** Access to the design tokens inside [PostHistoryTheme]: `Vl.colors.actionPrimary`, `Vl.text.headline`. */
object Vl {
    val colors: VlColors @Composable @ReadOnlyComposable get() = LocalVlColors.current
    val text: VlTextStyles @Composable @ReadOnlyComposable get() = LocalVlText.current
    val dark: Boolean @Composable @ReadOnlyComposable get() = LocalVlDark.current
}

private val sharedStyles = VlTextStyles()

@Composable
fun PostHistoryTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val c = if (dark) VlDarkColors else VlLightColors
    val styles = sharedStyles
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = c.actionPrimary, onPrimary = c.textOnBrand, primaryContainer = c.actionSoft, onPrimaryContainer = c.textBrand,
        secondary = c.textSecondary, onSecondary = c.bgRaised, secondaryContainer = c.actionSoft, onSecondaryContainer = c.textPrimary,
        tertiary = c.textBrand, onTertiary = c.textOnBrand,
        background = c.bgBase, onBackground = c.textPrimary, surface = c.bgBase, onSurface = c.textPrimary,
        surfaceVariant = c.bgSunken, onSurfaceVariant = c.textSecondary, surfaceContainerLowest = c.bgRaised, surfaceContainerLow = c.bgRaised,
        surfaceContainer = c.bgRaised, surfaceContainerHigh = c.bgRaised, surfaceContainerHighest = c.bgSunken,
        error = c.stateDanger, onError = c.textOnBrand, errorContainer = c.bgSunken, onErrorContainer = c.stateDanger,
        outline = c.borderEdge, outlineVariant = c.borderLine, inverseSurface = c.textPrimary, inverseOnSurface = c.bgBase,
    )
    val typography = Typography(
        displaySmall = styles.display, headlineLarge = styles.display, headlineMedium = styles.title, headlineSmall = styles.title,
        titleLarge = styles.title, titleMedium = styles.headline, titleSmall = styles.action,
        bodyLarge = styles.body, bodyMedium = styles.body, bodySmall = styles.caption,
        labelLarge = styles.action, labelMedium = styles.label, labelSmall = styles.caption,
    )
    CompositionLocalProvider(LocalVlColors provides c, LocalVlText provides styles, LocalVlDark provides dark) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
