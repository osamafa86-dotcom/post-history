package net.palpost.library.core.send

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer

/**
 * What the app remembers for the reporter between sends (reporter-v2.md «الإرسال»), as on iOS (`ReporterMemory`): the
 * governorate and city of the last send, the display name chosen in the settings (`real_name` by default), and the reporter's
 * earlier tags as suggestions (never copied into the next send). Tags are free text that may hold sensitive names (ADR 0086):
 * the file stays on the phone, out of backups, and the emergency wipe, sign-out and revocation erase it. Never coordinates.
 */
data class ReporterMemory(
    val governorate: String = "",
    val city: String = "",
    /** Newest first, no repeats by folded Arabic matching. */
    val recentTags: List<String> = emptyList(),
    /** Contract value of `DisplayName.mode`, or null when never chosen. */
    val displayMode: String? = null,
    val pseudonym: String = "",
) {
    val hasPlace: Boolean get() = governorate.isNotEmpty() && city.isNotEmpty()

    /** The default display name of a new send: the chosen one, else `real_name`. */
    val effectiveDisplayMode: String get() = displayMode?.takeIf { it in DISPLAY_MODES } ?: "real_name"

    /** After a successful send: the place becomes «from your last send», and its tags lead the suggestions. */
    fun rememberSend(governorate: String, city: String, tags: List<String>): ReporterMemory {
        val g = governorate.trim()
        val c = city.trim()
        val fresh = tags.map(ArabicFold::key).toSet()
        val kept = recentTags.filter { ArabicFold.key(it) !in fresh }
        val seen = HashSet<String>()
        val merged = (tags + kept).filter { seen.add(ArabicFold.key(it)) }.take(TAG_HISTORY_LIMIT)
        return copy(governorate = if (g.isNotEmpty() && c.isNotEmpty()) g else this.governorate, city = if (g.isNotEmpty() && c.isNotEmpty()) c else this.city, recentTags = merged)
    }

    /** The place on the send screen is the one remembered from the last send («From your last send» under the chip). */
    fun isRemembered(governorate: String, city: String): Boolean = hasPlace && governorate == this.governorate && city == this.city

    fun toJson(): String = adapter.toJson(
        mapOf("governorate" to governorate, "city" to city, "recentTags" to recentTags, "displayMode" to displayMode, "pseudonym" to pseudonym),
    )

    companion object {
        const val TAG_HISTORY_LIMIT = 60
        val DISPLAY_MODES = setOf("real_name", "pseudonym", "network")

        private val adapter = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)).serializeNulls()

        /** Every field is optional in the file, so a field added later does not lose what was saved; unreadable reads as empty. */
        fun fromJson(json: String): ReporterMemory = runCatching {
            val m = adapter.fromJson(json) ?: return ReporterMemory()
            ReporterMemory(
                governorate = m["governorate"] as? String ?: "",
                city = m["city"] as? String ?: "",
                recentTags = (m["recentTags"] as? List<*>)?.filterIsInstance<String>().orEmpty().take(TAG_HISTORY_LIMIT),
                displayMode = (m["displayMode"] as? String)?.takeIf { it in DISPLAY_MODES },
                pseudonym = m["pseudonym"] as? String ?: "",
            )
        }.getOrDefault(ReporterMemory())
    }
}
