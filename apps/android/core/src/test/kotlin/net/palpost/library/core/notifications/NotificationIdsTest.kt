package net.palpost.library.core.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class NotificationIdsTest {
    @Test
    fun `receipts, pushes and the transfer never share an id`() {
        assertTrue(NotificationIds.UPLOAD_RESULTS.last < NotificationIds.PUSH.first)
        assertFalse(NotificationIds.UPLOAD_PROGRESS in NotificationIds.UPLOAD_RESULTS)
        assertFalse(NotificationIds.UPLOAD_PROGRESS in NotificationIds.PUSH)
        val rnd = java.util.Random(7)
        // Every key lands inside its own range, the hash extremes included.
        val keys = List(2_000) { UUID(rnd.nextLong(), rnd.nextLong()).toString() } + listOf("", "a", "￿".repeat(9))
        for (k in keys) {
            assertTrue(NotificationIds.uploadResult(k) in NotificationIds.UPLOAD_RESULTS)
            assertTrue(NotificationIds.push(k) in NotificationIds.PUSH)
        }
        assertTrue(NotificationIds.push(null) in NotificationIds.PUSH)
        val receipts = keys.map(NotificationIds::uploadResult).toSet()
        assertTrue(keys.map(NotificationIds::push).none { it in receipts })
    }
}
