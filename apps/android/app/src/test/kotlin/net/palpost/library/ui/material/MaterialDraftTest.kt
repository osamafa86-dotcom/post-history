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
            files = listOf(
                PickedOriginal("content://media/picker/0/1", "clip.mp4", 123_456_789, "video/mp4"),
                PickedOriginal("content://media/picker/0/2", "photo.jpg", 4_000_000, "image/jpeg"),
                PickedOriginal("content://media/picker/0/3", "unknown", 0, null),
            ),
            step = 3,
        )
        assertEquals(d, MaterialDraft.fromJson(d.toJson()))
    }

    @Test
    fun `a draft saved before multi-pick opens with its one file`() {
        // The exact shape v1 wrote: a single original in four sibling keys, no `files`.
        val v1 = """{"v":1,"title":"قصف على حي الرمال","types":["breaking"],"governorate":"غزة","city":"غزة","priority":"urgent",
            "minors":true,"injured":false,"graphic":false,"displayMode":"network","pseudonym":"","values":{"camera":"phone"},
            "originalUri":"content://media/picker/0/1","originalName":"clip.mp4","originalSize":123456789,"originalMime":"video/mp4","step":3}"""
        val d = MaterialDraft.fromJson(v1)!!
        assertEquals(listOf(PickedOriginal("content://media/picker/0/1", "clip.mp4", 123_456_789, "video/mp4")), d.files)
        assertEquals("قصف على حي الرمال", d.title)
        assertEquals(3, d.step)
        // Saved again, it is written as v2 and reads back the same.
        assertEquals(d, MaterialDraft.fromJson(d.toJson()))
    }

    @Test
    fun `a v1 draft without a file, and a draft with no files at all, have an empty list`() {
        assertEquals(emptyList<PickedOriginal>(), MaterialDraft.fromJson("""{"v":1,"originalUri":null,"originalName":null,"originalSize":0,"originalMime":null,"step":1}""")!!.files)
        assertEquals(emptyList<PickedOriginal>(), MaterialDraft.fromJson("""{"v":2,"files":[],"step":1}""")!!.files)
        assertEquals(emptyList<PickedOriginal>(), MaterialDraft.fromJson("""{"step":1}""")!!.files)
    }

    @Test
    fun `reading files skips broken entries, repeats, and anything beyond the cap`() {
        val rows = (2..25).joinToString(",") { """{"uri":"content://f/$it","name":"f$it","size":$it,"mime":"video/mp4"}""" }
        val json = """{"v":2,"files":[{"name":"no uri"},{"uri":""},"junk",{"uri":"content://f/1","name":"first"},{"uri":"content://f/1","name":"second"},$rows],"step":1}"""
        val files = MaterialDraft.fromJson(json)!!.files
        assertEquals(PickedFiles.MAX, files.size)
        assertEquals("content://f/1", files.first().uri)
        assertEquals("first", files.first().name) // the first occurrence of a repeated URI wins
        assertEquals(PickedFiles.MAX, files.map { it.uri }.toSet().size)
    }

    @Test
    fun `an unreadable draft is ignored and an out-of-range step is clamped`() {
        assertNull(MaterialDraft.fromJson("not json"))
        assertEquals(4, MaterialDraft.fromJson("""{"step": 9}""")!!.step)
        assertNull(MaterialDraft.fromJson("""{"step": 1}""")!!.minors) // no default for the sensitivity questions
    }
}
