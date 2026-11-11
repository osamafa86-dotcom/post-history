package net.palpost.library.core.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The upload row tells a screen reader about three states only; progress is never one of them. */
class UploadAnnouncementTest {
    @Test
    fun `a row that is moving, waiting or preparing announces nothing`() {
        assertNull(UploadAnnouncement.of(done = false, failed = false, paused = false))
    }

    @Test
    fun `failed, paused and arrived are each announced`() {
        assertEquals(UploadAnnouncement.FAILED, UploadAnnouncement.of(done = false, failed = true, paused = false))
        assertEquals(UploadAnnouncement.PAUSED, UploadAnnouncement.of(done = false, failed = false, paused = true))
        assertEquals(UploadAnnouncement.ARRIVED, UploadAnnouncement.of(done = true, failed = false, paused = false))
    }

    @Test
    fun `an arrived file is arrived even if it was paused, and a failure outranks a pause`() {
        assertEquals(UploadAnnouncement.ARRIVED, UploadAnnouncement.of(done = true, failed = false, paused = true))
        assertEquals(UploadAnnouncement.FAILED, UploadAnnouncement.of(done = false, failed = true, paused = true))
    }
}
