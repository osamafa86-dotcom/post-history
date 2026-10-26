package net.palpost.library.ui.material

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MaterialDraftTest {
    @Test
    fun `a draft survives the round trip through its stored JSON`() {
        val d = MaterialDraft(
            title = "قصف على حي الرمال", types = listOf("breaking", "raw_footage"), governorate = "غزة", city = "غزة", priority = "urgent",
            minors = true, injured = null, graphic = false, displayMode = "pseudonym", pseudonym = "م.ع",
            values = mapOf("camera" to "phone", "count" to 3.0, "tags" to listOf("a", "b")),
            originalUri = "content://media/picker/0/1", originalName = "clip.mp4", originalSize = 123_456_789, originalMime = "video/mp4", step = 3,
        )
        assertEquals(d, MaterialDraft.fromJson(d.toJson()))
    }

    @Test
    fun `an unreadable draft is ignored and an out-of-range step is clamped`() {
        assertNull(MaterialDraft.fromJson("not json"))
        assertEquals(4, MaterialDraft.fromJson("""{"step": 9}""")!!.step)
        assertNull(MaterialDraft.fromJson("""{"step": 1}""")!!.minors) // no default for the sensitivity questions
    }
}
