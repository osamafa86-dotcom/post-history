package net.palpost.library.core.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReporterMemoryTest {
    @Test
    fun `a send remembers its place and puts its tags first, without repeats by folded matching`() {
        val m = ReporterMemory(recentTags = listOf("\u0623\u0645\u0637\u0627\u0631", "old"))
            .rememberSend(" G ", " C ", listOf("new", "\u0627\u0645\u0637\u0627\u0631"))
        assertEquals("G", m.governorate)
        assertEquals("C", m.city)
        assertEquals(listOf("new", "\u0627\u0645\u0637\u0627\u0631", "old"), m.recentTags)
        assertTrue(m.isRemembered("G", "C"))
        assertFalse(m.isRemembered("G", "other"))
    }

    @Test
    fun `an empty place does not replace the remembered one, and history is capped`() {
        val m = ReporterMemory("G", "C").rememberSend("", "C2", (1..80).map { "t$it" })
        assertEquals("G", m.governorate)
        assertEquals("C", m.city)
        assertEquals(ReporterMemory.TAG_HISTORY_LIMIT, m.recentTags.size)
    }

    @Test
    fun `display name defaults to the real name`() {
        assertEquals("real_name", ReporterMemory().effectiveDisplayMode)
        assertEquals("pseudonym", ReporterMemory(displayMode = "pseudonym").effectiveDisplayMode)
        assertEquals("real_name", ReporterMemory(displayMode = "something_new").effectiveDisplayMode)
    }

    @Test
    fun `the file round-trips, tolerates missing fields and reads garbage as empty`() {
        val m = ReporterMemory("G", "C", listOf("a"), "network", "p")
        assertEquals(m, ReporterMemory.fromJson(m.toJson()))
        assertEquals(ReporterMemory(governorate = "G"), ReporterMemory.fromJson("{\"governorate\":\"G\"}"))
        assertEquals(ReporterMemory(), ReporterMemory.fromJson("not json"))
        assertFalse(m.toJson().contains("lat"))
    }
}
