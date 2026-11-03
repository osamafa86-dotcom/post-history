package net.palpost.library.core.materials

import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.MaterialFile.Kind
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.core.materials.Fixtures.file
import net.palpost.library.core.materials.Fixtures.material
import net.palpost.library.core.upload.AccountScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class GalleryTest {
    @Test
    fun `the coverage title drops the send's numbering only`() {
        assertEquals("Field title", CoverageTitle.display("Field title (2/5)"))
        assertEquals("Field title (6/5)", CoverageTitle.display("Field title (6/5)"))
        assertEquals("Field title (1/1)", CoverageTitle.display("Field title (1/1)"))
        assertEquals("Field (title)", CoverageTitle.display("Field (title)"))
        assertEquals(CoverageTitle.key("Field  title (1/3)"), CoverageTitle.key("field title (3/3)"))
    }

    @Test
    fun `a send's materials are one group, newest groups first`() {
        val a1 = material(1, title = "Alpha (1/2)")
        val a2 = material(2, title = "Alpha (2/2)")
        val b = material(3, title = "Beta", types = setOf(MaterialType.interview))
        val sections = MaterialGallery.sections(listOf(a1, b, a2), GalleryGrouping.COVERAGE, GalleryQuickFilter.ALL) { MediaKind.VIDEO }
        assertEquals(listOf("Beta", "Alpha"), sections.map { it.coverage })
        assertEquals(listOf(a2.id, a1.id), sections[1].materials.map { it.id })
        val byType = MaterialGallery.sections(listOf(a1, b, a2), GalleryGrouping.TYPE, GalleryQuickFilter.ALL) { MediaKind.VIDEO }
        assertEquals(listOf(MaterialType.interview, MaterialType.report), byType.map { it.type })
    }

    @Test
    fun `quick filters each look at one thing`() {
        val urgent = material(1, priority = Priority.urgent)
        val photo = material(2, files = listOf(file(1, Kind.original, mime = "image/jpeg")))
        val needs = material(3, editorial = EditorialState.needs_changes)
        val all = listOf(urgent, photo, needs)
        fun ids(f: GalleryQuickFilter) = MaterialGallery.sections(all, GalleryGrouping.COVERAGE, f) { MaterialMedia.kind(it) }.flatMap { it.materials }.map { it.id }
        assertEquals(listOf(urgent.id), ids(GalleryQuickFilter.URGENT))
        assertEquals(listOf(photo.id), ids(GalleryQuickFilter.PHOTO))
        assertEquals(listOf(needs.id, urgent.id), ids(GalleryQuickFilter.VIDEO))
        assertEquals(listOf(needs.id), ids(GalleryQuickFilter.NEEDS_ACTION))
    }

    @Test
    fun `media kind, duration and the group's day`() {
        assertEquals(MediaKind.PHOTO, MaterialMedia.kind(material(1, types = setOf(MaterialType.photos))))
        assertEquals(MediaKind.PHOTO, MaterialMedia.kind(material(1), localMimeType = "image/heic"))
        assertEquals(MediaKind.VIDEO, MaterialMedia.kind(material(1, files = listOf(file(1, Kind.proxy)))))
        assertEquals(102_000L, MaterialMedia.durationMs(material(1, files = listOf(file(1, Kind.proxy, duration = 5), file(2, Kind.original, duration = 102_000)))))
        assertNull(MaterialMedia.durationMs(material(1)))
        assertEquals("1:42", MaterialMedia.clock(102_000))
        assertEquals("1:02:03", MaterialMedia.clock(3_723_000))
        val day = 86_400_000L
        val now = 20 * day + 3_600_000
        assertEquals(GalleryDay.Today, GalleryDay.of(now - 1_000, now, ZoneOffset.UTC))
        assertEquals(GalleryDay.Yesterday, GalleryDay.of(now - day, now, ZoneOffset.UTC))
        assertEquals(GalleryDay.On(LocalDate.ofEpochDay(18)), GalleryDay.of(18 * day, now, ZoneOffset.UTC))
    }

    @Test
    fun `receipts wait for their owner and come back once`() {
        val inbox = ReceiptInbox<String>()
        val a = AccountScope("a", null)
        val b = AccountScope("b", null)
        assertEquals("r1", inbox.arrive("r1", "a", a))
        assertNull(inbox.arrive("r2", "a", b))
        inbox.hold("r2", "a")
        assertEquals(1, inbox.count)
        assertNull(inbox.next(b))
        assertNull(inbox.next(AccountScope(null, null)))
        assertEquals("r2", inbox.next(a))
        assertNull(inbox.next(a))
        inbox.hold("r3", null)
        assertNull(inbox.next(AccountScope("a", "b")))
        assertEquals("r3", inbox.next(AccountScope("a", "a")))
        inbox.hold("r4", "a")
        inbox.removeAll()
        assertNull(inbox.next(a))
    }
}
