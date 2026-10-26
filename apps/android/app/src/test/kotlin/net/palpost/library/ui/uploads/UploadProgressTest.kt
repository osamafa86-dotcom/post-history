package net.palpost.library.ui.uploads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UploadProgressTest {
    @Test
    fun `parts follow the session's part size and only server-confirmed bytes`() {
        val p = UploadParts.of(sizeBytes = 100, confirmedBytes = 45, partSizeBytes = 10, active = true)
        assertEquals(10, p.total)
        assertEquals(4, p.confirmed)
        assertEquals(5, p.current)
        assertEquals(List(4) { PartState.CONFIRMED } + PartState.CURRENT + List(5) { PartState.LATER }, p.bars)
    }

    @Test
    fun `more than twelve parts are grouped into twelve bars at most`() {
        val p = UploadParts.of(sizeBytes = 1000, confirmedBytes = 500, partSizeBytes = 10, active = true)
        assertEquals(100, p.total)
        assertEquals(50, p.confirmed)
        assertEquals(51, p.current)
        assert(p.bars.size <= 12)
        assertEquals(PartState.CONFIRMED, p.bars.first())
        assertEquals(PartState.LATER, p.bars.last())
        assertEquals(1, p.bars.count { it == PartState.CURRENT })
    }

    @Test
    fun `before a session the file is cut into twelve, and a finished or idle upload has no current part`() {
        val idle = UploadParts.of(sizeBytes = 1200, confirmedBytes = 0, partSizeBytes = null, active = false)
        assertEquals(12, idle.total)
        assertNull(idle.current)
        val done = UploadParts.of(sizeBytes = 1200, confirmedBytes = 1200, partSizeBytes = 7, active = true)
        assertEquals(done.total, done.confirmed)
        assertNull(done.current)
        assertEquals(0, UploadParts.of(0, 0, null, true).total)
    }

    @Test
    fun `no estimate under three samples or without movement, then remaining over the window's speed`() {
        val m = SpeedMeter()
        m.add(0, 0)
        m.add(10_000, 1_000_000)
        assertNull(m.etaSeconds(5_000_000))
        m.add(20_000, 2_000_000)
        assertEquals(50L, m.etaSeconds(5_000_000)) // 100 kB/s
        m.add(25_000, 2_000_000) // same bytes: not a new sample
        assertEquals(50L, m.etaSeconds(5_000_000))
    }

    @Test
    fun `samples older than the window drop and a restart from fewer bytes resets`() {
        val m = SpeedMeter(windowMs = 30_000)
        m.add(0, 0); m.add(10_000, 100); m.add(20_000, 200)
        m.add(60_000, 10_200) // first samples fall out of the 30 s window
        assertNull(m.etaSeconds(1_000)) // only two left
        m.add(70_000, 0) // a new attempt from zero
        assertNull(m.etaSeconds(1_000))
    }
}
