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
}
