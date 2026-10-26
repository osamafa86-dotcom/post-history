package net.palpost.library.ui.receipt

import net.palpost.library.api.models.TransitionRecord
import java.time.OffsetDateTime

/** The plain rules of the receipt card (A3), kept apart from the screen so they are tested. */
object ReceiptModel {
    /**
     * What the shared receipt image carries, and nothing more: the receipt number and when it was received. The
     * digest, the title, the size, the supervisor line and the QR stay on the screen only, because the image goes
     * to any app the reporter picks and even a partial digest ties a leaked original to them (security review, #395).
     */
    data class ShareContent(val receiptNumber: String, val receivedAtEpochMs: Long)

    fun shareContent(receiptNumber: String?, receivedAtEpochMs: Long): ShareContent? =
        receiptNumber?.takeIf { it.isNotBlank() }?.let { ShareContent(it, receivedAtEpochMs) }

    /** SHA-256 shortened to its first and last 8 characters, as the card prints it. */
    fun shortDigest(sha256: String?): String? = sha256?.takeIf { it.length > 16 }?.let { it.take(8) + "…" + it.takeLast(8) } ?: sha256

    /**
     * The QR's content: the material's page in the web app, which opens only for the roles allowed to see it. The
     * link carries the material's id and nothing else (no place, no name). Null when no web origin was built in.
     */
    fun materialLink(webBaseUrl: String, language: String, materialId: String): String? {
        val base = webBaseUrl.trimEnd('/')
        if (!base.startsWith("https://")) return null
        val locale = if (language == "en") "en" else "ar"
        return "$base/$locale/materials/$materialId"
    }

    /** When a supervisor first acknowledged the material (editorial track reaching `acknowledged`), if ever. */
    fun acknowledgedAt(transitions: List<TransitionRecord>): OffsetDateTime? =
        transitions.filter { it.track.value == "editorial" && it.to == "acknowledged" }.minByOrNull { it.occurredAt }?.occurredAt
}
