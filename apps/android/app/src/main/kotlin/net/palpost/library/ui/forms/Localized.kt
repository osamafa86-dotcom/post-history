package net.palpost.library.ui.forms

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import net.palpost.library.R
import net.palpost.library.api.models.LocalizedText
import net.palpost.library.api.models.MaterialType
import java.util.Locale

/** Arabic text for an Arabic UI, English otherwise (the two the contract guarantees). */
fun LocalizedText.forLocale(locale: Locale): String = if (locale.language == "ar") ar else en

@Composable
fun LocalizedText.localized(): String = forLocale(LocalConfiguration.current.locales[0] ?: Locale.getDefault())

@Composable
fun materialTypeLabel(type: MaterialType): String = stringResource(
    when (type) {
        MaterialType.breaking -> R.string.material_type_breaking
        MaterialType.report -> R.string.material_type_report
        MaterialType.interview -> R.string.material_type_interview
        MaterialType.raw_footage -> R.string.material_type_raw_footage
        MaterialType.aerial -> R.string.material_type_aerial
        MaterialType.press_conference -> R.string.material_type_press_conference
        MaterialType.eyewitness -> R.string.material_type_eyewitness
        MaterialType.photos -> R.string.material_type_photos
    },
)
