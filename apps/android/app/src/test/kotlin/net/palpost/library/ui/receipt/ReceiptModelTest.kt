package net.palpost.library.ui.receipt

import net.palpost.library.api.models.TransitionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.OffsetDateTime

class ReceiptModelTest {
    @Test
    fun `the digest is shortened to its first and last eight characters`() {
        val sha = "0123456789abcdef".repeat(4)
        assertEquals("01234567…89abcdef", ReceiptModel.shortDigest(sha))
        assertNull(ReceiptModel.shortDigest(null))
    }

    @Test
    fun `the QR link carries only the material id, over https, in the app's language`() {
        assertEquals("https://lib.example/ar/materials/m-1", ReceiptModel.materialLink("https://lib.example/", "ar", "m-1"))
        assertEquals("https://lib.example/en/materials/m-1", ReceiptModel.materialLink("https://lib.example", "en", "m-1"))
        assertEquals("https://lib.example/ar/materials/m-1", ReceiptModel.materialLink("https://lib.example", "fr", "m-1"))
        assertNull(ReceiptModel.materialLink("", "ar", "m-1"))
        assertNull(ReceiptModel.materialLink("http://lib.example", "ar", "m-1"))
    }

    @Test
    fun `the supervisor's acknowledgement is the first editorial move to acknowledged`() {
        val t0 = OffsetDateTime.parse("2026-10-26T10:00:00Z")
        val list = listOf(
            record("technical", "original_received", "verified", t0),
            record("editorial", "acknowledged", "reviewing", t0.plusMinutes(9)),
            record("editorial", "inbox", "acknowledged", t0.plusMinutes(5)),
        )
        assertEquals(t0.plusMinutes(5), ReceiptModel.acknowledgedAt(list))
        assertNull(ReceiptModel.acknowledgedAt(list.take(1)))
    }

    private fun record(track: String, from: String, to: String, at: OffsetDateTime) =
        TransitionRecord(id = "$track-$to", track = TransitionRecord.Track.entries.first { it.value == track }, from = from, to = to, reason = "r", actorId = null, occurredAt = at)
}
