package net.palpost.library.ui.forms

import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/** Pure helpers between what the user types and the JSON value the validator sees; unit-tested on the JVM. */
object FieldInput {
    private val ARABIC_INDIC = '٠'..'٩'
    private val EXTENDED_ARABIC_INDIC = '۰'..'۹'
    private val RFC3339_SECONDS: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssXXX")

    /** Digits typed on an Arabic keyboard become ASCII; the decimal separator may be `٫` or `,`. */
    fun normalizeDigits(text: String): String = buildString(text.length) {
        for (c in text) append(
            when (c) {
                in ARABIC_INDIC -> '0' + (c - ARABIC_INDIC.first)
                in EXTENDED_ARABIC_INDIC -> '0' + (c - EXTENDED_ARABIC_INDIC.first)
                '٫', ',' -> '.'
                else -> c
            },
        )
    }

    /** Empty → null (missing); a number → Double; anything else stays a String so the validator reports `type`. */
    fun numberValue(text: String): Any? {
        val t = normalizeDigits(text).trim()
        if (t.isEmpty()) return null
        return t.toDoubleOrNull()?.takeIf { it.isFinite() } ?: t
    }

    /** Empty → null; otherwise the text as typed (no trimming: spaces are content). */
    fun textValue(text: String): Any? = text.ifEmpty { null }

    /** A full RFC 3339 date-time with seconds, which the shared rules require (`2026-10-19T14:30:00+03:00`). */
    fun nowRfc3339(): String = OffsetDateTime.now().format(RFC3339_SECONDS)

    fun formatRfc3339(t: OffsetDateTime): String = t.format(RFC3339_SECONDS)

    fun describeBytes(bytes: Long): String = when {
        bytes >= 1L shl 30 -> "%.1f GiB".format(bytes / (1L shl 30).toDouble())
        bytes >= 1L shl 20 -> "%.1f MiB".format(bytes / (1L shl 20).toDouble())
        bytes >= 1L shl 10 -> "%.0f KiB".format(bytes / (1L shl 10).toDouble())
        else -> "$bytes B"
    }
}
