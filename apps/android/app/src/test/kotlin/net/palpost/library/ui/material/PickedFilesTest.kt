package net.palpost.library.ui.material

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PickedFilesTest {
    private fun file(n: Int, size: Long = 1_000L * n, mime: String? = "video/mp4") = PickedOriginal("content://media/picker/0/$n", "clip$n.mp4", size, mime)

    @Test
    fun `files enter the list in the order picked and later picks are appended`() {
        val first = PickedFiles.add(emptyList(), listOf(file(3), file(1), file(2)))
        assertEquals(listOf(3, 1, 2).map { file(it) }, first.files)
        assertEquals(3, first.added)
        val more = PickedFiles.add(first.files, listOf(file(9)))
        assertEquals(listOf(3, 1, 2, 9).map { file(it) }, more.files)
    }

    @Test
    fun `the same file twice is added once and counted`() {
        val first = PickedFiles.add(emptyList(), listOf(file(1), file(2)))
        val second = PickedFiles.add(first.files, listOf(file(2), file(3), file(3)))
        assertEquals(listOf(1, 2, 3).map { file(it) }, second.files)
        assertEquals(1, second.added)
        assertEquals(2, second.duplicates)
        assertEquals(0, second.overLimit)
    }

    @Test
    fun `a material holds at most twenty files and the rest is counted, not lost silently`() {
        val twelve = PickedFiles.add(emptyList(), (1..12).map { file(it) })
        assertEquals(8, PickedFiles.remaining(twelve.files))
        val over = PickedFiles.add(twelve.files, (13..30).map { file(it) })
        assertEquals(PickedFiles.MAX, over.files.size)
        assertEquals((1..20).map { file(it) }, over.files)
        assertEquals(8, over.added)
        assertEquals(10, over.overLimit)
        assertEquals(0, PickedFiles.remaining(over.files))
        // A full list takes nothing more, but a repeat is still reported as a repeat.
        val full = PickedFiles.add(over.files, listOf(file(5), file(99)))
        assertEquals(over.files, full.files)
        assertEquals(1, full.duplicates)
        assertEquals(1, full.overLimit)
    }

    @Test
    fun `removing a row frees its place and touches nothing else`() {
        val list = PickedFiles.add(emptyList(), (1..20).map { file(it) }).files
        val less = PickedFiles.remove(list, file(7).uri)
        assertEquals(19, less.size)
        assertFalse(less.any { it.uri == file(7).uri })
        assertEquals(1, PickedFiles.remaining(less))
        assertEquals(list, PickedFiles.remove(list, "content://never/picked")) // an unknown row is a no-op
        // The removed file can be picked again afterwards.
        assertTrue(PickedFiles.add(less, listOf(file(7))).files.any { it.uri == file(7).uri })
    }

    @Test
    fun `the total counts known sizes only`() {
        val list = listOf(file(1, size = 1_000), file(2, size = 2_500), file(3, size = 0), file(4, size = -1))
        assertEquals(3_500L, PickedFiles.totalBytes(list))
        assertEquals(0L, PickedFiles.totalBytes(emptyList()))
    }

    @Test
    fun `a video is told by its mime type`() {
        assertTrue(file(1, mime = "video/mp4").isVideo)
        assertFalse(file(1, mime = "image/jpeg").isVideo)
        assertFalse(file(1, mime = null).isVideo)
    }

    @Test
    fun `only a file without a key gets one, and a lone legacy file takes the draft-level key`() {
        var n = 0
        val gen = { "gen-${++n}" }
        // A draft saved before multi-pick: one file, no key of its own.
        assertEquals(listOf(file(1).copy(materialKey = "draft-key")), PickedFiles.stampKeys(listOf(file(1)), "draft-key", gen))
        assertEquals(0, n)
        // Several files with no keys get one each; a file that has its key keeps it.
        val stamped = PickedFiles.stampKeys(listOf(file(1).copy(materialKey = "mine"), file(2), file(3)), "draft-key", gen)
        assertEquals(listOf("mine", "gen-1", "gen-2"), stamped.map { it.materialKey })
        // Stamping twice changes nothing: the keys are already there.
        assertEquals(stamped, PickedFiles.stampKeys(stamped, "draft-key", gen))
    }

    @Test
    fun `the first send numbers the files 1 to n of n`() {
        val numbered = PickedFiles.assignPositions((1..4).map { file(it) })
        assertEquals(listOf(1, 2, 3, 4), numbered.map { it.position })
        assertEquals(listOf(4, 4, 4, 4), numbered.map { it.total })
    }

    @Test
    fun `files left after a partial send keep their numbers, and new ones continue after them`() {
        val left = listOf(file(1).copy(position = 4, total = 5), file(2).copy(position = 5, total = 5))
        assertEquals(left, PickedFiles.assignPositions(left))
        assertEquals(5, PickedFiles.groupSize(left))
        val more = PickedFiles.assignPositions(left + file(3))
        assertEquals(listOf(4, 5, 6), more.map { it.position })
        assertEquals(listOf(5, 5, 6), more.map { it.total })
    }

    @Test
    fun `the title leaves room for the longest suffix and a single file has none`() {
        assertEquals("", MaterialTitles.suffix(1, 1))
        assertEquals(" (2/5)", MaterialTitles.suffix(2, 5))
        assertEquals(80, MaterialTitles.maxBase(1))
        assertEquals(74, MaterialTitles.maxBase(5)) // " (5/5)" is 6 characters
        assertEquals(80 - " (9/9)".length, MaterialTitles.maxBase(9))
        assertEquals(80 - " (10/10)".length, MaterialTitles.maxBase(10))
        assertEquals(72, MaterialTitles.maxBase(PickedFiles.MAX)) // " (20/20)" is 8 characters
    }

    @Test
    fun `a base title is valid only if it plus the longest suffix fits`() {
        val seventy2 = "ع".repeat(72)
        assertTrue(MaterialTitles.baseValid(seventy2, 20))
        assertFalse(MaterialTitles.baseValid(seventy2 + "ع", 20))
        assertTrue(MaterialTitles.baseValid(seventy2 + "ع", 1)) // 73 characters fit when there is no numbering
        assertFalse(MaterialTitles.baseValid("abcd", 3)) // below the minimum
        assertTrue(MaterialTitles.baseValid("abcde", 3))
        // The longest numbered title never passes the contract maximum.
        for (total in 2..PickedFiles.MAX) {
            val base = "x".repeat(MaterialTitles.maxBase(total))
            for (i in 1..total) assertTrue(MaterialTitles.length(MaterialTitles.titleFor(base, i, total)) <= MaterialTitles.MAX)
        }
        // Characters are counted as code points, as the server counts them.
        assertEquals(2, MaterialTitles.length("a\uD83D\uDE00"))
    }

    @Test
    fun `the queue row and session key follow the material, so a repeat rewrites the same row`() {
        assertEquals(UploadIds.taskId("material-1"), UploadIds.taskId("material-1"))
        assertEquals(UploadIds.sessionKey("material-1"), UploadIds.sessionKey("material-1"))
        assertFalse(UploadIds.taskId("material-1") == UploadIds.taskId("material-2"))
        assertFalse(UploadIds.taskId("material-1") == UploadIds.sessionKey("material-1"))
    }

    @Test
    fun `the stored title has a plain ASCII suffix and no invisible direction characters`() {
        val bidi = Regex("[\\u2066-\\u2069\\u200E\\u200F\\u202A-\\u202E]")
        val asciiSuffix = Regex(" \\(\\d{1,2}/\\d{1,2}\\)")
        for (total in 2..PickedFiles.MAX) {
            for (i in 1..total) {
                val suffix = MaterialTitles.suffix(i, total)
                assertTrue(suffix, asciiSuffix.matches(suffix) && suffix.all { it.code < 128 })
                assertFalse(suffix, bidi.containsMatchIn(suffix))
                val title = MaterialTitles.titleFor("قصف على حي الرمال", i, total)
                assertFalse(title, bidi.containsMatchIn(title))
                assertTrue(title.endsWith(suffix))
            }
        }
        // The reserve the validator keeps is exactly the longest stored suffix, nothing more or less.
        for (total in 2..PickedFiles.MAX) {
            assertEquals(MaterialTitles.MAX - MaterialTitles.longestSuffix(total).length, MaterialTitles.maxBase(total))
        }
        assertEquals("", MaterialTitles.suffix(1, 1)) // a single file's title is untouched
    }

    @Test
    fun `selection decides before anything is read, so a refused file never gets a grant`() {
        val current = (1..19).map { file(it) }
        val sel = PickedFiles.select(current, listOf(file(3).uri, file(20).uri, file(20).uri, file(21).uri, file(22).uri))
        assertEquals(listOf(file(20).uri), sel.accepted) // 3 is already there, the second 20 repeats, 21 and 22 are past the limit
        assertEquals(2, sel.duplicates)
        assertEquals(2, sel.overLimit)
        assertEquals(PickedFiles.add(current, listOf(file(3), file(20), file(20), file(21), file(22))).files, current + file(20))
    }
}
