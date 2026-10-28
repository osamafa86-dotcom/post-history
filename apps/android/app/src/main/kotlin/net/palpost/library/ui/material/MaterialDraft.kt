package net.palpost.library.ui.material

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer

/**
 * An A1 draft as it is kept on the phone (`Save draft`, spec A1): the fixed fields, the office form's values and
 * the picked originals' URIs, by contract values so a draft survives app updates. Attachment fields of the office
 * form are not kept: their files must be picked again (their read grant may not outlive the draft).
 *
 * v1 kept one original (`originalUri` and its siblings); v2 keeps a list (`files`). [fromJson] reads both, so a
 * draft saved before multi-pick opens with its one file, and no Room migration is needed (the table holds JSON text).
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
    val files: List<PickedOriginal> = emptyList(),
    val step: Int = 1,
) {
    fun toJson(): String = adapter.toJson(
        mapOf(
            "v" to 2, "title" to title, "types" to types, "governorate" to governorate, "city" to city, "priority" to priority,
            "minors" to minors, "injured" to injured, "graphic" to graphic, "displayMode" to displayMode, "pseudonym" to pseudonym,
            "values" to values, "files" to files.map { mapOf("uri" to it.uri, "name" to it.name, "size" to it.sizeBytes, "mime" to it.mimeType) },
            "step" to step,
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
                files = readFiles(m),
                step = (m["step"] as? Number)?.toInt()?.coerceIn(1, 4) ?: 1,
            )
        }.getOrNull()

        /** `files` (v2) when present; otherwise the single original of a v1 draft. Unreadable entries are skipped, the cap holds. */
        @Suppress("UNCHECKED_CAST")
        private fun readFiles(m: Map<String, Any?>): List<PickedOriginal> {
            val list = m["files"] as? List<*>
            if (list != null) {
                return list.mapNotNull { e ->
                    val f = e as? Map<String, Any?> ?: return@mapNotNull null
                    val uri = (f["uri"] as? String)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    PickedOriginal(uri, f["name"] as? String ?: "original", (f["size"] as? Number)?.toLong() ?: 0, f["mime"] as? String)
                }.distinctBy { it.uri }.take(PickedFiles.MAX)
            }
            val legacy = (m["originalUri"] as? String)?.takeIf { it.isNotBlank() } ?: return emptyList()
            return listOf(PickedOriginal(legacy, m["originalName"] as? String ?: "original", (m["originalSize"] as? Number)?.toLong() ?: 0, m["originalMime"] as? String))
        }
    }
}
