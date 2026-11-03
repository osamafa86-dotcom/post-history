package net.palpost.library.core.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class CaptureDateTest {
    private val utc = ZoneId.of("UTC")

    @Test
    fun `exif date with its offset, else the phone's zone`() {
        assertEquals(Instant.parse("2026-11-02T10:30:00Z").toEpochMilli(), CaptureDate.exif("2026:11:02 12:30:00", "+02:00", utc))
        assertEquals(Instant.parse("2026-11-02T12:30:00Z").toEpochMilli(), CaptureDate.exif("2026:11:02 12:30:00", null, utc))
        assertEquals(Instant.parse("2026-11-02T18:00:00Z").toEpochMilli(), CaptureDate.exif("2026:11:02 12:30:00", "-0530", utc))
    }

    @Test
    fun `empty or broken dates are not dates`() {
        assertNull(CaptureDate.exif("0000:00:00 00:00:00", null, utc))
        assertNull(CaptureDate.exif("yesterday", null, utc))
        assertNull(CaptureDate.exif(null, null, utc))
        assertEquals(Instant.parse("2026-11-02T12:30:00Z").toEpochMilli(), CaptureDate.exif("2026:11:02 12:30:00", "+99:00", utc))
    }

    @Test
    fun `video container dates are UTC, and the 1904 epoch is no date`() {
        assertEquals(Instant.parse("2026-11-02T09:15:07Z").toEpochMilli(), CaptureDate.video("20261102T091507.000Z"))
        assertNull(CaptureDate.video("19040101T000000.000Z"))
        assertNull(CaptureDate.video("garbage"))
        assertNull(CaptureDate.video(null))
    }
}
