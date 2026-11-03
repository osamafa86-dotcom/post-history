package net.palpost.library.ui.theme

import androidx.compose.ui.graphics.toArgb
import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.ui.theme.tokens.VlDarkColors
import net.palpost.library.ui.theme.tokens.VlFontKind
import net.palpost.library.ui.theme.tokens.VlLightColors
import net.palpost.library.ui.theme.tokens.VlMotion
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.ui.theme.tokens.VlType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/** The generated tokens match docs/design/tokens.v2.json, read independently here (ADR 0085, 0088); v1 is gone from the app. */
class DesignTokensTest {
    @Suppress("UNCHECKED_CAST")
    private val root = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java))
        .fromJson(File("../../../docs/design/tokens.v2.json").readText())!!

    @Suppress("UNCHECKED_CAST")
    private fun lookup(path: String): Any? = path.split('.').fold(root as Any?) { o, k -> (o as Map<String, Any?>)[k] }

    @Suppress("UNCHECKED_CAST")
    private fun color(group: String, name: String, mode: String): Int {
        val ref = ((lookup("color.$group.$name") as Map<String, Any?>)["\$value"] as Map<String, String>).getValue(mode)
        val hex = (lookup(ref.trim('{', '}')) as Map<String, Any?>)["\$value"] as String
        return (0xFF000000 or hex.removePrefix("#").toLong(16)).toInt()
    }

    @Test
    fun `semantic colours in both modes`() {
        assertEquals(color("bg", "base", "light"), VlLightColors.bgBase.toArgb())
        assertEquals(color("bg", "base", "dark"), VlDarkColors.bgBase.toArgb())
        assertEquals(color("action", "primary", "light"), VlLightColors.actionPrimary.toArgb())
        assertEquals(color("action", "gradient-end", "dark"), VlDarkColors.actionGradientEnd.toArgb())
        assertEquals(color("sensitivity", "border", "light"), VlLightColors.sensitivityBorder.toArgb())
        assertEquals(color("priority", "urgent", "dark"), VlDarkColors.priorityUrgent.toArgb())
        assertEquals(color("state", "danger", "light"), VlLightColors.stateDanger.toArgb())
    }

    @Test
    fun `the three tracks' tones point at the state colours`() {
        assertEquals(VlLightColors.stateOk, VlLightColors.materialTechnicalReady)
        assertEquals(VlDarkColors.stateWarn, VlDarkColors.materialEditorialReview)
        assertEquals(VlLightColors.stateBrand, VlLightColors.materialRightsListed)
        assertEquals(Signal.BRAND, signalOf(Tone.GOOD, Track.RIGHTS))
        assertEquals(Signal.WARN, signalOf(Tone.PROGRESS, Track.EDITORIAL))
        assertEquals(Signal.MUTED, signalOf(Tone.PROGRESS, Track.TECHNICAL))
        assertEquals(Signal.WARN, signalOf(Tone.BAD, Track.RIGHTS))
        assertEquals(Signal.URGENT, signalOf(Tone.URGENT, null))
    }

    @Test
    fun `dimensions, motion and type roles`() {
        assertEquals(16f, VlSpace.s5.value)
        assertEquals(44f, VlSize.touchMin.value)
        assertEquals(54f, VlSize.ctaMin.value)
        assertEquals(18f, VlRadius.md.value)
        assertEquals(2400, VlMotion.pulseMs)
        assertEquals(16f, VlType.body.size.value)
        assertEquals(26f, VlType.body.lineHeight.value)
        assertEquals(800, VlType.display.weight.weight)
        assertEquals(VlFontKind.DISPLAY, VlType.title.kind)
        assertEquals(VlFontKind.TEXT, VlType.headline.kind)
        assertEquals(VlFontKind.NUM, VlType.num.kind)
    }

    @Test
    fun `touch targets are 48dp, above the iOS figure in the tokens`() {
        assert(MinTouchTarget.value >= 48f)
        assert(MinTouchTarget >= VlSize.touchMin)
    }

    @Test
    fun `the generated file is v2 only`() {
        val generated = File("src/main/kotlin/net/palpost/library/ui/theme/tokens/DesignTokens.kt").readText()
        assert(generated.contains("tokens.v2.json"))
        assertFalse(generated.contains("tokens.json "))
        assertFalse(File("src/main/res/font").list()!!.any { it.startsWith("vazirmatn") || it.startsWith("reem_kufi") })
    }
}
