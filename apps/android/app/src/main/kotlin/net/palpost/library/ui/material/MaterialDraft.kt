package net.palpost.library.ui.material

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer

/**
 * An A1 draft as it is kept on the phone (`Save draft`, spec A1): the fixed fields, the office form's values and
 * the picked original's URI, by contract values so a draft survives app updates. Attachment fields of the office
 * form are not kept: their files must be picked again (their read grant may not outlive the draft).
 */
data class MaterialDraft(
    val title: String = "",
    val types: List<String> = emptyList(),
    val governorate: String = "",
    val city: String = "",
    val priority: String = "normal",
    val minors: Boolean? = null,
    val injured: Boolean? = null,
    val graphic: Boolean? = null,
    val displayMode: String = "network",
    val pseudonym: String = "",
    val values: Map<String, Any?> = emptyMap(),
    val originalUri: String? = null,
    val originalName: String? = null,
    val originalSize: Long = 0,
    val originalMime: String? = null,
    val step: Int = 1,
) {
    fun toJson(): String = adapter.toJson(
        mapOf(
            "v" to 1, "title" to title, "types" to types, "governorate" to governorate, "city" to city, "priority" to priority,
            "minors" to minors, "injured" to injured, "graphic" to graphic, "displayMode" to displayMode, "pseudonym" to pseudonym,
            "values" to values, "originalUri" to originalUri, "originalName" to originalName, "originalSize" to originalSize,
            "originalMime" to originalMime, "step" to step,
        ),
    )

    companion object {
        private val adapter = Serializer.moshi.adapter<Map<String, Any?>>(Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)).serializeNulls()

        @Suppress("UNCHECKED_CAST")
        fun fromJson(json: String): MaterialDraft? = runCatching {
            val m = adapter.fromJson(json) ?: return null
            MaterialDraft(
                title = m["title"] as? String ?: "",
                types = (m["types"] as? List<*>)?.filterIsInstance<String>().orEmpty(),
                governorate = m["governorate"] as? String ?: "",
                city = m["city"] as? String ?: "",
                priority = m["priority"] as? String ?: "normal",
                minors = m["minors"] as? Boolean, injured = m["injured"] as? Boolean, graphic = m["graphic"] as? Boolean,
                displayMode = m["displayMode"] as? String ?: "network",
                pseudonym = m["pseudonym"] as? String ?: "",
                values = (m["values"] as? Map<String, Any?>).orEmpty(),
                originalUri = m["originalUri"] as? String, originalName = m["originalName"] as? String,
                originalSize = (m["originalSize"] as? Number)?.toLong() ?: 0, originalMime = m["originalMime"] as? String,
                step = (m["step"] as? Number)?.toInt()?.coerceIn(1, 4) ?: 1,
            )
        }.getOrNull()
    }
}
