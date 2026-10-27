package net.palpost.library.ui.theme

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
import net.palpost.library.R
import net.palpost.library.ui.theme.tokens.VlColors
import net.palpost.library.ui.theme.tokens.VlDarkColors
import net.palpost.library.ui.theme.tokens.VlFontKind
import net.palpost.library.ui.theme.tokens.VlLightColors
import net.palpost.library.ui.theme.tokens.VlType
import net.palpost.library.ui.theme.tokens.VlTypeRole

/**
 * The design system (docs/design/design-system.md) on Compose: colours, type and shapes come from the generated
 * tokens (`ui/theme/tokens`, built from docs/design/tokens.json), never from literals. Dark mode follows the system,
 * for the field at night. Fonts are the open-licensed faces the system names (the Figma file's: Vazirmatn for text in
 * Arabic and English, Reem Kufi for display, ADR 0079), bundled so they work offline.
 */
private val Vazirmatn = FontFamily(
    Font(R.font.vazirmatn_400, FontWeight.Normal),
    Font(R.font.vazirmatn_500, FontWeight.Medium),
    Font(R.font.vazirmatn_600, FontWeight.SemiBold),
    Font(R.font.vazirmatn_700, FontWeight.Bold),
)
private val ReemKufi = FontFamily(
    Font(R.font.reem_kufi_700, FontWeight.Bold),
)
private val IbmPlexMono = FontFamily(
    Font(R.font.ibm_plex_mono_400, FontWeight.Normal),
    Font(R.font.ibm_plex_mono_500, FontWeight.Medium),
)

/** The type roles of the design system as text styles, each in its role's family. */
class VlTextStyles {
    fun of(role: VlTypeRole): TextStyle = TextStyle(
        fontFamily = when (role.kind) { VlFontKind.MONO -> IbmPlexMono; VlFontKind.DISPLAY -> ReemKufi; VlFontKind.TEXT -> Vazirmatn },
        fontSize = role.size, lineHeight = role.lineHeight, fontWeight = role.weight,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )
    val displayMd get() = of(VlType.displayMd)
    val headingH2 get() = of(VlType.headingH2)
    val headingH3 get() = of(VlType.headingH3)
    val headingH4 get() = of(VlType.headingH4)
    val bodyLg get() = of(VlType.bodyLg)
    val bodyMd get() = of(VlType.bodyMd)
    val bodySm get() = of(VlType.bodySm)
    val labelLg get() = of(VlType.labelLg)
    val labelMd get() = of(VlType.labelMd)
    val labelSm get() = of(VlType.labelSm)
    val captionMd get() = of(VlType.captionMd)
    val overlineMd get() = of(VlType.overlineMd)
    val monoMd get() = of(VlType.monoMd)
    val monoLg get() = of(VlType.monoLg)
}

private val LocalVlColors = staticCompositionLocalOf { VlLightColors }
private val LocalVlText = staticCompositionLocalOf { VlTextStyles() }

/** Access to the design tokens inside [PostHistoryTheme]: `Vl.colors.bgBrand`, `Vl.text.headingH4`. */
object Vl {
    val colors: VlColors @Composable @ReadOnlyComposable get() = LocalVlColors.current
    val text: VlTextStyles @Composable @ReadOnlyComposable get() = LocalVlText.current
}

@Composable
fun PostHistoryTheme(content: @Composable () -> Unit) {
    val c = if (isSystemInDarkTheme()) VlDarkColors else VlLightColors
    val styles = VlTextStyles()
    val scheme = (if (c === VlDarkColors) darkColorScheme() else lightColorScheme()).copy(
        primary = c.bgBrand, onPrimary = c.textOnBrand, primaryContainer = c.bgBrandSubtle, onPrimaryContainer = c.textBrand,
        secondary = c.textSecondary, onSecondary = c.bgSurface, secondaryContainer = c.bgSubtle, onSecondaryContainer = c.textPrimary,
        background = c.bgCanvas, onBackground = c.textPrimary, surface = c.bgSurface, onSurface = c.textPrimary,
        surfaceVariant = c.bgSubtle, onSurfaceVariant = c.textSecondary, surfaceContainer = c.bgSurface,
        surfaceContainerLow = c.bgSurface, surfaceContainerHigh = c.bgSurfaceRaised, surfaceContainerHighest = c.bgSubtle,
        error = c.textDanger, onError = c.textOnBrand, errorContainer = c.bgDangerSubtle, onErrorContainer = c.textDanger,
        outline = c.borderStrong, outlineVariant = c.borderDefault, inverseSurface = c.bgInverse, inverseOnSurface = c.textInverse,
    )
    val typography = Typography(
        displaySmall = styles.displayMd, headlineSmall = styles.headingH2, titleLarge = styles.headingH3,
        titleMedium = styles.headingH4, titleSmall = styles.labelLg, bodyLarge = styles.bodyMd, bodyMedium = styles.bodyMd,
        bodySmall = styles.bodySm, labelLarge = styles.labelLg, labelMedium = styles.labelMd, labelSmall = styles.labelSm,
    )
    CompositionLocalProvider(LocalVlColors provides c, LocalVlText provides styles) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
