package net.palpost.library.ui.material

import android.text.format.DateUtils
import androidx.annotation.StringRes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import net.palpost.library.R
import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.RightsState
import net.palpost.library.api.models.TechnicalState

/** Localised labels of a material's states and files, shared by A4 (My materials) and the supervisor's review. */
@Composable
internal fun StateLine(@StringRes label: Int, @StringRes value: Int) =
    Text(stringResource(label) + ": " + stringResource(value), style = MaterialTheme.typography.bodyMedium)

internal fun relative(epochMs: Long): String = DateUtils.getRelativeTimeSpanString(epochMs, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

@StringRes internal fun technical(s: TechnicalState) = when (s) {
    TechnicalState.pending -> R.string.technical_pending
    TechnicalState.proxy_received -> R.string.technical_proxy_received
    TechnicalState.original_received -> R.string.technical_original_received
    TechnicalState.verified -> R.string.technical_verified
    TechnicalState.failed -> R.string.technical_failed
}

@StringRes internal fun editorial(s: EditorialState) = when (s) {
    EditorialState.inbox -> R.string.editorial_inbox
    EditorialState.acknowledged -> R.string.editorial_acknowledged
    EditorialState.reviewing -> R.string.editorial_reviewing
    EditorialState.needs_changes -> R.string.editorial_needs_changes
    EditorialState.accepted -> R.string.editorial_accepted
    EditorialState.in_production -> R.string.editorial_in_production
    EditorialState.final_review -> R.string.editorial_final_review
    EditorialState.published -> R.string.editorial_published
    EditorialState.rejected -> R.string.editorial_rejected
}

@StringRes internal fun rights(s: RightsState) = when (s) {
    RightsState.unknown -> R.string.rights_unknown
    RightsState.documented -> R.string.rights_documented
    RightsState.sellable -> R.string.rights_sellable
    RightsState.blocked -> R.string.rights_blocked
    RightsState.withdrawn -> R.string.rights_withdrawn
}

/**
 * Keyed by the contract value, not the generated enum, so kinds a newer contract adds (`shot_list`, a sensitive
 * derivative only editing roles and the owning reporter see) still compile and get a generic label.
 */
@StringRes internal fun fileKind(k: MaterialFile.Kind) = when (k.value) {
    "original" -> R.string.file_kind_original
    "proxy" -> R.string.file_kind_proxy
    "hls" -> R.string.file_kind_hls
    "audio" -> R.string.file_kind_audio
    "thumbnail" -> R.string.file_kind_thumbnail
    "voice_note" -> R.string.file_kind_voice_note
    "transcript" -> R.string.file_kind_transcript
    "captions" -> R.string.file_kind_captions
    "shot_list" -> R.string.file_kind_shot_list
    else -> R.string.file_kind_other
}

@StringRes internal fun fileState(s: MaterialFile.State) = when (s) {
    MaterialFile.State.uploading -> R.string.file_state_uploading
    MaterialFile.State.received -> R.string.file_state_received
    MaterialFile.State.verified -> R.string.file_state_verified
    MaterialFile.State.failed -> R.string.file_state_failed
}

/** A state's label by its contract value, for transition records (strings); an unknown value shows as sent. */
@Composable
fun stateLabel(track: String, value: String): String = when (track) {
    "technical" -> TechnicalState.entries.firstOrNull { it.value == value }?.let { stringResource(technical(it)) }
    "rights" -> RightsState.entries.firstOrNull { it.value == value }?.let { stringResource(rights(it)) }
    else -> EditorialState.entries.firstOrNull { it.value == value }?.let { stringResource(editorial(it)) }
} ?: value
