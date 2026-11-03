package net.palpost.library.core.send

import java.util.Locale

/**
 * The filming location (`gps`, ADR 0087): collected with an explicit «while in use» permission, sent with `POST /materials`
 * (write-only, encrypted per field on the server), and never shown, logged or put in a preview, notification or export.
 * On the phone it lives in memory, and only while a send still has materials to create, sealed with the Keystore in the
 * protected queue database; it is erased when the send's last material is created, and by the emergency wipe.
 */
data class GpsFix(val lat: Double, val lng: Double, val accuracyM: Double?, val atEpochMs: Long) {
    /** Within the contract's bounds (`GpsPoint`: lat −90…90, lng −180…180, accuracy ≥ 0). */
    val valid: Boolean get() =
        lat.isFinite() && lng.isFinite() && lat in -90.0..90.0 && lng in -180.0..180.0 && (accuracyM == null || (accuracyM.isFinite() && accuracyM >= 0))

    /** The sealed form's plain text, before the Keystore seals it; never logged. */
    fun encode(): String = listOf(lat, lng, accuracyM ?: -1.0).joinToString(";") { String.format(Locale.ROOT, "%.7f", it) } + ";" + atEpochMs

    override fun toString(): String = "GpsFix(redacted)"

    companion object {
        fun decode(s: String?): GpsFix? = runCatching {
            val p = s!!.split(';')
            val acc = p[2].toDouble()
            GpsFix(p[0].toDouble(), p[1].toDouble(), if (acc < 0) null else acc, p[3].toLong()).takeIf { it.valid }
        }.getOrNull()
    }
}

object GpsPolicy {
    /** A fix older than this when «Send» is tapped is not this filming's place. */
    const val MAX_AGE_MS = 10 * 60_000L

    /** The fix to send: valid and fresh, or none (the send goes without `gps`; declining never blocks it, ADR 0087 §2). */
    fun usable(fix: GpsFix?, nowMs: Long): GpsFix? = fix?.takeIf { it.valid && nowMs - it.atEpochMs in 0..MAX_AGE_MS }

    /** The fresher of two fixes (the one taken when the screen opened, and the one read on «Send»). */
    fun fresher(a: GpsFix?, b: GpsFix?): GpsFix? = when {
        a == null -> b
        b == null -> a
        else -> if (b.atEpochMs >= a.atEpochMs) b else a
    }
}

/**
 * The location permission screen (frame 13) comes once, before the first send, explaining why before the system's dialog
 * (ADR 0087 §1). Not again after an answer, whichever it was; the reporter can change it in the phone's settings.
 */
object LocationConsent {
    fun shouldExplain(alreadyAsked: Boolean, granted: Boolean): Boolean = !alreadyAsked && !granted
}
