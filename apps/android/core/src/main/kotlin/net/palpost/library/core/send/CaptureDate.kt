package net.palpost.library.core.send

import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * The filming time read from the file (`shot_at`, «read from the file», reporter-v2.md), as on iOS (`CaptureDate`): a photo's
 * EXIF `DateTimeOriginal` («yyyy:MM:dd HH:mm:ss») with `OffsetTimeOriginal` («+02:00») when present, else the phone's zone;
 * a video's container date («yyyyMMdd'T'HHmmss.SSS'Z'», UTC). Nothing else is read from the file: no place, no device id.
 */
object CaptureDate {
    private val EXIF = DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss")

    fun exif(value: String?, offset: String?, zone: ZoneId = ZoneId.systemDefault()): Long? {
        val v = value?.trim()?.takeIf { it.isNotEmpty() && !it.startsWith("0000") } ?: return null
        val local = try { LocalDateTime.parse(v, EXIF) } catch (e: DateTimeParseException) { return null }
        val z: ZoneId = offset?.let(::zoneOf) ?: zone
        return local.atZone(z).toInstant().toEpochMilli()
    }

    /** `MediaMetadataRetriever.METADATA_KEY_DATE`; containers without a date give «19040101T000000.000Z», which is not a date. */
    fun video(value: String?): Long? {
        val v = value?.trim()?.takeIf { it.length >= 15 } ?: return null
        val local = try { LocalDateTime.parse(v.substring(0, 15), DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss")) } catch (e: DateTimeParseException) { return null }
        if (local.year < 1970) return null
        return local.toInstant(ZoneOffset.UTC).toEpochMilli()
    }

    /** «+02:00» or «-0530» to a fixed zone. */
    fun zoneOf(offset: String): ZoneOffset? {
        val s = offset.trim()
        if (s.isEmpty() || (s[0] != '+' && s[0] != '-')) return null
        val digits = s.drop(1).filter(Char::isDigit)
        if (digits.length != 4) return null
        val h = digits.take(2).toInt()
        val m = digits.takeLast(2).toInt()
        if (h > 14 || m >= 60) return null
        val seconds = (h * 3600 + m * 60) * if (s[0] == '-') -1 else 1
        return ZoneOffset.ofTotalSeconds(seconds)
    }
}
