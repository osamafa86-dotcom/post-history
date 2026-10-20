package net.palpost.library.core.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class RequestSizerTest {
    private var now = 0L
    private val kib = 1024
    private val sizer = RequestSizer(minBytes = 128 * kib, maxBytes = 1024 * kib, targetMs = 20_000, clock = { now })

    @Test fun `starts at the part size and follows the acknowledged rate`() {
        assertEquals(1024 * kib, sizer.begin(0))
        now += 80_000 // 1 MiB in 80 s: 12.8 KiB/s
        sizer.acknowledged(1024L * kib)
        assertEquals(256 * kib, sizer.next()) // 20 s worth
        assertEquals(256 * kib, sizer.begin(1024L * kib))
        now += 2_000 // 256 KiB in 2 s: 128 KiB/s -> 2.5 MiB, capped
        sizer.acknowledged(1280L * kib)
        assertEquals(1024 * kib, sizer.next())
    }

    @Test fun `a cut request is measured up to the failure from what HEAD finds, not the backoff`() {
        sizer.begin(0)
        now += 90_000
        sizer.failed()
        now += 60_000 // backoff
        sizer.serverOffset(540L * kib) // 540 KiB in 90 s: 6 KiB/s -> 120 KiB, floored
        assertEquals(128 * kib, sizer.next())
    }

    @Test fun `an attempt that moved nothing keeps the last rate`() {
        sizer.begin(0); now += 20_000; sizer.acknowledged(512L * kib) // 25.6 KiB/s -> 512 KiB
        assertEquals(512 * kib, sizer.begin(512L * kib))
        now += 30_000; sizer.failed(); sizer.serverOffset(512L * kib) // blackout: no byte landed
        assertEquals(512 * kib, sizer.next())
    }

    @Test fun `a HEAD outside an attempt changes nothing`() {
        sizer.serverOffset(123L * kib)
        assertEquals(1024 * kib, sizer.next())
    }
}
