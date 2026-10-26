package net.palpost.library.ui.material

import net.palpost.library.api.models.Material
import net.palpost.library.api.models.TransitionRecord
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Track

/**
 * The rules of A4 (My materials) apart from the screen: which materials need the reporter, the tone of each state,
 * and the one timeline of three tracks that are never merged (CLAUDE.md §5: the three states stay independent).
 * States are matched by their contract value, so a value a newer contract adds falls to a neutral tone.
 */
object MaterialTimeline {
    /** "Needs action": the supervisor asked for changes, or the technical track failed. */
    fun needsAction(m: Material): Boolean = m.editorialState.value == "needs_changes" || m.technicalState.value == "failed"

    fun technicalTone(value: String): Tone = when (value) {
        "verified" -> Tone.GOOD
        "failed" -> Tone.BAD
        "proxy_received", "original_received" -> Tone.PROGRESS
        else -> Tone.NEUTRAL
    }

    fun editorialTone(value: String): Tone = when (value) {
        "needs_changes" -> Tone.ATTENTION
        "published" -> Tone.GOOD
        "rejected" -> Tone.BAD
        "inbox", "acknowledged", "reviewing", "accepted", "in_production", "final_review" -> Tone.PROGRESS
        else -> Tone.NEUTRAL
    }

    fun rightsTone(value: String): Tone = when (value) {
        "sellable" -> Tone.GOOD
        "blocked" -> Tone.BAD
        "documented" -> Tone.PROGRESS
        else -> Tone.NEUTRAL
    }

    fun trackOf(r: TransitionRecord): Track = when (r.track.value) {
        "technical" -> Track.TECHNICAL
        "rights" -> Track.RIGHTS
        else -> Track.EDITORIAL
    }

    /** Newest first; [only] keeps one track (tapping its badge), never a blend of two. */
    fun events(transitions: List<TransitionRecord>, only: Track?): List<TransitionRecord> =
        transitions.filter { only == null || trackOf(it) == only }.sortedByDescending { it.occurredAt }

    /** The supervisor's latest request for changes, shown above the timeline while the material awaits the reporter. */
    fun supervisorNote(m: Material, transitions: List<TransitionRecord>): TransitionRecord? =
        if (m.editorialState.value != "needs_changes") null
        else transitions.filter { it.track.value == "editorial" && it.to == "needs_changes" }.maxByOrNull { it.occurredAt }
}
