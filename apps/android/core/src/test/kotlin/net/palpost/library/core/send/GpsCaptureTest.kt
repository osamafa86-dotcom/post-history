package net.palpost.library.core.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GpsCaptureTest {
    private val fix = GpsFix(31.5, 34.46, 12.0, 1_000)

    @Test
    fun `a fix within the contract's bounds is valid`() {
        assertTrue(fix.valid)
        assertFalse(fix.copy(lat = 90.5).valid)
        assertFalse(fix.copy(lng = -180.1).valid)
        assertFalse(fix.copy(accuracyM = -1.0).valid)
        assertFalse(fix.copy(lat = Double.NaN).valid)
        assertTrue(fix.copy(accuracyM = null).valid)
    }

    @Test
    fun `the sealed text round-trips and never shows in logs`() {
        assertEquals(fix, GpsFix.decode(fix.encode()))
        assertEquals(fix.copy(accuracyM = null), GpsFix.decode(fix.copy(accuracyM = null).encode()))
        assertNull(GpsFix.decode("garbage"))
        assertNull(GpsFix.decode(null))
        assertNull(GpsFix.decode("95;0;1;0"))
        assertFalse(fix.toString().contains("31"))
    }

    @Test
    fun `only a fresh valid fix is sent, and declining sends none`() {
        assertEquals(fix, GpsPolicy.usable(fix, nowMs = 1_000 + GpsPolicy.MAX_AGE_MS))
        assertNull(GpsPolicy.usable(fix, nowMs = 1_001 + GpsPolicy.MAX_AGE_MS))
        assertNull(GpsPolicy.usable(fix, nowMs = 999))
        assertNull(GpsPolicy.usable(null, nowMs = 0))
        val later = fix.copy(atEpochMs = 5_000)
        assertEquals(later, GpsPolicy.fresher(fix, later))
        assertEquals(later, GpsPolicy.fresher(later, fix))
        assertEquals(fix, GpsPolicy.fresher(null, fix))
    }

    @Test
    fun `the permission screen comes once and never when already granted`() {
        assertTrue(LocationConsent.shouldExplain(alreadyAsked = false, granted = false))
        assertFalse(LocationConsent.shouldExplain(alreadyAsked = true, granted = false))
        assertFalse(LocationConsent.shouldExplain(alreadyAsked = false, granted = true))
    }
}
