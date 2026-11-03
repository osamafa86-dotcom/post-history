package net.palpost.library.core.notifications

import net.palpost.library.core.materials.LocalRecord
import net.palpost.library.core.notifications.NotificationLinks.Step
import net.palpost.library.core.upload.AccountScope
import net.palpost.library.core.upload.UploadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationLinksTest {
    private val material = "0000000a-0000-4000-8000-00000000000b"
    private val key = "sample-link-key"

    @Test
    fun `the reporter's own news opens the material, the receipt opens the receipt, the rest the list`() {
        assertEquals(NotificationTarget.Material(material), NotificationLinks.targetOf("material.change_requested", material))
        assertEquals(NotificationTarget.Material(material), NotificationLinks.targetOf("material.acknowledged", material))
        assertEquals(NotificationTarget.Material(material), NotificationLinks.targetOf("material.published", material))
        assertEquals(NotificationTarget.Receipt(material), NotificationLinks.targetOf("upload.verified", material))
        assertEquals(NotificationTarget.Receipt(material), NotificationLinks.targetOf("upload.deduplicated", material))
        // A supervisor's notification, an escalation or one without a material: the list, as before.
        assertEquals(NotificationTarget.Inbox, NotificationLinks.targetOf("material.urgent_received", material))
        assertEquals(NotificationTarget.Inbox, NotificationLinks.targetOf("notification.escalated", material))
        assertEquals(NotificationTarget.Inbox, NotificationLinks.targetOf("material.published", null))
        assertEquals(NotificationTarget.Inbox, NotificationLinks.targetOf(null, material))
    }

    @Test
    fun `only a well-formed id is carried, in its canonical form`() {
        assertEquals(material, NotificationLinks.materialId(material.uppercase()))
        assertNull(NotificationLinks.materialId("1-1-1-1-1"))
        assertNull(NotificationLinks.materialId("$material/../x"))
        assertNull(NotificationLinks.materialId(""))
        assertEquals(NotificationTarget.Inbox, NotificationLinks.targetOf("material.published", "not-an-id"))
    }

    @Test
    fun `the intent carries the kind, the id, the local account and the key, and reads back the same`() {
        val link = NotificationLink(NotificationTarget.Receipt(material), "local-account-1")
        val extras = NotificationLinks.extras(link, key)
        assertEquals(setOf("open", "material", "account", "key"), extras.keys)
        assertEquals(link, NotificationLinks.parse(extras::get, key))
        val inbox = NotificationLink(NotificationTarget.Inbox, null)
        assertEquals(inbox, NotificationLinks.parse(NotificationLinks.extras(inbox, key)::get, key))
    }

    @Test
    fun `a material link without this installation's key, or with a bad id, is refused`() {
        val extras = NotificationLinks.extras(NotificationLink(NotificationTarget.Material(material), null), key)
        assertNull(NotificationLinks.parse(extras::get, "another-key"))
        assertNull(NotificationLinks.parse(extras::get, null))
        assertNull(NotificationLinks.parse((extras - "key")::get, key))
        assertNull(NotificationLinks.parse((extras + ("material" to "../x"))::get, key))
        assertNull(NotificationLinks.parse(mapOf("open" to "settings", "key" to key)::get, key))
        assertNull(NotificationLinks.parse(emptyMap<String, String>()::get, key))
        // The list, as earlier releases asked for it, opens without a key.
        assertEquals(NotificationLink(NotificationTarget.Inbox, null), NotificationLinks.parse(mapOf("open" to "notifications")::get, null))
    }

    @Test
    fun `a waiting tap is followed for its own account, dropped for another, and waits for the scope`() {
        val link = NotificationLink(NotificationTarget.Material(material), "a")
        assertEquals(Step.Wait, NotificationLinks.step(link, AccountScope(null, "a")))
        assertEquals(Step.Open(link.target), NotificationLinks.step(link, AccountScope("a", null)))
        assertEquals(Step.Drop, NotificationLinks.step(link, AccountScope("b", "b")))
        val unknown = link.copy(account = null)
        assertEquals(Step.Open(unknown.target), NotificationLinks.step(unknown, AccountScope("b", null)))
    }

    @Test
    fun `the receipt opens on the account's own verified original, the newest`() {
        fun rec(id: String, kind: String = "original", state: UploadState = UploadState.VERIFIED, at: Long = 1, m: String = material) =
            LocalRecord(id, m, kind, null, state, at, "video/mp4", "content://sample/$id")
        val records = listOf(
            rec("old", at = 1), rec("new", state = UploadState.DEDUPLICATED, at = 5), rec("moving", state = UploadState.UPLOADING, at = 9),
            rec("proxy", kind = "proxy", at = 10), rec("other", m = "0000000a-0000-4000-8000-00000000000c", at = 11),
        )
        assertEquals("new", NotificationLinks.receiptRecord(material.uppercase(), records)?.id)
        assertNull(NotificationLinks.receiptRecord(material, records.filter { it.state == UploadState.UPLOADING }))
        assertTrue(NotificationLinks.receiptRecord(material, emptyList()) == null)
        assertFalse(NotificationLinks.RECEIPT_EVENTS.any { it in NotificationLinks.MATERIAL_EVENTS })
    }
}
