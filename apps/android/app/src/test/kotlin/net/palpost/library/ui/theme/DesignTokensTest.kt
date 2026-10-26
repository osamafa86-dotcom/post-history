package net.palpost.library.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.ui.theme.tokens.VlDarkColors
import net.palpost.library.ui.theme.tokens.VlLightColors
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.ui.theme.tokens.VlType
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The generated tokens match docs/design/tokens.json, read independently here. */
class DesignTokensTest {
    @Suppress("UNCHECKED_CAST")
    private val root = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java))
        .fromJson(File("../../../docs/design/tokens.json").readText())!!

    @Suppress("UNCHECKED_CAST")
    private fun semantic(name: String, mode: String): Int {
        val color = root["color"] as Map<String, Any?>
        val ref = (((color["semantic"] as Map<String, Any?>)[name] as Map<String, Any?>)["\$value"] as Map<String, String>).getValue(mode)
        val path = ref.trim('{', '}').split('.')
        val hex = ((((color["primitive"] as Map<String, Any?>)[path[2]] as Map<String, Any?>)[path[3]] as Map<String, Any?>)["\$value"] as String)
        return (0xFF000000 or hex.removePrefix("#").toLong(16)).toInt()
    }

    @Test
    fun `semantic colours in both modes`() {
        assertEquals(semantic("bg/brand", "light"), VlLightColors.bgBrand.toArgb())
        assertEquals(semantic("bg/brand", "dark"), VlDarkColors.bgBrand.toArgb())
        assertEquals(semantic("tone/urgent/bg", "light"), VlLightColors.toneUrgentBg.toArgb())
        assertEquals(semantic("track/rights/accent", "dark"), VlDarkColors.trackRightsAccent.toArgb())
        assert(VlLightColors.textPrimary != Color.Unspecified)
    }

    @Test
    fun `dimensions and type roles`() {
        assertEquals(16f, VlSpace.s5.value)
        assertEquals(44f, VlSize.touchMin.value)
        assertEquals(16f, VlType.bodyMd.size.value)
        assertEquals(26f, VlType.bodyMd.lineHeight.value)
        assertEquals(500, VlType.monoLg.weight.weight)
    }
}
