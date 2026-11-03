package net.palpost.library.core.materials

import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.MaterialFile.Kind
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.RightsState
import net.palpost.library.api.models.TechnicalState
import net.palpost.library.core.materials.Fixtures.file
import net.palpost.library.core.materials.Fixtures.material
import net.palpost.library.core.upload.AccountScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
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
        val sections = MaterialGallery.sections(listOf(a1, b, a2), GalleryGrouping.COVERAGE) { MediaKind.VIDEO }
        assertEquals(listOf("Beta", "Alpha"), sections.map { it.coverage })
        assertEquals(listOf(a2.id, a1.id), sections[1].materials.map { it.id })
        val byType = MaterialGallery.sections(listOf(a1, b, a2), GalleryGrouping.TYPE) { MediaKind.VIDEO }
        assertEquals(listOf(MaterialType.interview, MaterialType.report), byType.map { it.type })
    }

    @Test
    fun `quick chips are the four of frame 07 and each looks at one thing`() {
        assertEquals(listOf("ALL", "VIDEO", "PHOTO", "URGENT"), GalleryQuickFilter.entries.map { it.name })
        val urgent = material(1, priority = Priority.urgent)
        val photo = material(2, files = listOf(file(1, Kind.original, mime = "image/jpeg")))
        val needs = material(3, editorial = EditorialState.needs_changes)
        val all = listOf(urgent, photo, needs)
        fun ids(f: GalleryQuickFilter) = MaterialGallery.sections(all, GalleryGrouping.COVERAGE, GalleryFilter(quick = f)) { MaterialMedia.kind(it) }.flatMap { it.materials }.map { it.id }
        assertEquals(listOf(urgent.id), ids(GalleryQuickFilter.URGENT))
        assertEquals(listOf(photo.id), ids(GalleryQuickFilter.PHOTO))
        assertEquals(listOf(needs.id, urgent.id), ids(GalleryQuickFilter.VIDEO))
        assertEquals(listOf(needs.id, photo.id, urgent.id), ids(GalleryQuickFilter.ALL))
    }

    @Test
    fun `each status in the sheet looks at its own track only`() {
        val needs = material(1, editorial = EditorialState.needs_changes)
        val failed = material(2, technical = TechnicalState.failed, editorial = EditorialState.accepted)
        val processing = material(3, technical = TechnicalState.original_received, editorial = EditorialState.reviewing)
        val approved = material(4, technical = TechnicalState.verified, editorial = EditorialState.published)
        val rejected = material(5, technical = TechnicalState.verified, editorial = EditorialState.rejected)
        val listed = material(6, technical = TechnicalState.verified, editorial = EditorialState.in_production, rights = RightsState.sellable)
        val all = listOf(needs, failed, processing, approved, rejected, listed)
        fun ids(s: GalleryStateFilter) = all.filter { GalleryStates.matches(it, s) }.map { it.id }
        assertEquals(listOf(needs.id, failed.id), ids(GalleryStateFilter.NEEDS_ACTION))
        // Technical: neither verified nor failed (pending in the fixtures by default).
        assertEquals(listOf(needs.id, processing.id), ids(GalleryStateFilter.PROCESSING))
        // Editorial: in review is neither approved nor rejected, changes asked included (its badge is «in review»).
        assertEquals(listOf(needs.id, processing.id), ids(GalleryStateFilter.IN_REVIEW))
        assertEquals(listOf(failed.id, approved.id, listed.id), ids(GalleryStateFilter.APPROVED))
        assertEquals(listOf(rejected.id), ids(GalleryStateFilter.REJECTED))
        // Rights: listed is sellable alone; documented, blocked and withdrawn are not.
        assertEquals(listOf(listed.id), ids(GalleryStateFilter.LISTED))
        assertFalse(GalleryStates.matches(material(7, rights = RightsState.documented), GalleryStateFilter.LISTED))
    }

    @Test
    fun `the date range counts the phone's calendar days and a late clock never hides a material`() {
        val zone: ZoneId = ZoneOffset.ofHours(2)
        val now = OffsetDateTime.parse("2026-11-03T00:30:00+02:00").toInstant().toEpochMilli()
        fun at(s: String) = OffsetDateTime.parse(s).toInstant().toEpochMilli()
        // Half an hour earlier is yesterday on the phone's calendar, though it is the same day in UTC.
        assertFalse(GalleryStates.within(GalleryDateRange.TODAY, at("2026-11-02T23:59:59+02:00"), now, zone))
        assertTrue(GalleryStates.within(GalleryDateRange.TODAY, at("2026-11-03T00:00:00+02:00"), now, zone))
        assertTrue(GalleryStates.within(GalleryDateRange.WEEK, at("2026-10-28T00:00:00+02:00"), now, zone))
        assertFalse(GalleryStates.within(GalleryDateRange.WEEK, at("2026-10-27T23:59:59+02:00"), now, zone))
        assertTrue(GalleryStates.within(GalleryDateRange.MONTH, at("2026-10-05T00:00:00+02:00"), now, zone))
        assertFalse(GalleryStates.within(GalleryDateRange.MONTH, at("2026-10-04T23:59:59+02:00"), now, zone))
        assertTrue(GalleryStates.within(GalleryDateRange.ANY, 0, now, zone))
        // A send dated ahead of the phone's clock.
        assertTrue(GalleryStates.within(GalleryDateRange.TODAY, now + 86_400_000, now, zone))
    }

    @Test
    fun `the sheet's filters combine with the chip, count apart from it, and clear without it`() {
        val now = Fixtures.t0.plusDays(1).toInstant().toEpochMilli()
        val old = material(1, at = Fixtures.t0.minusDays(40), types = setOf(MaterialType.interview), priority = Priority.urgent)
        val recentInterview = material(2, types = setOf(MaterialType.interview, MaterialType.report), priority = Priority.urgent)
        val recentReport = material(3, types = setOf(MaterialType.report), priority = Priority.urgent)
        val calm = material(4, types = setOf(MaterialType.interview))
        val all = listOf(old, recentInterview, recentReport, calm)
        val f = GalleryFilter(quick = GalleryQuickFilter.URGENT, dateRange = GalleryDateRange.MONTH, coverageType = MaterialType.interview)
        val shown = MaterialGallery.sections(all, GalleryGrouping.TYPE, f, nowMs = now, zone = ZoneOffset.UTC) { MediaKind.VIDEO }.flatMap { it.materials }
        assertEquals(listOf(recentInterview.id), shown.map { it.id })
        assertEquals(2, f.sheetCount)
        assertTrue(f.isActive)
        assertEquals(0, GalleryFilter(quick = GalleryQuickFilter.VIDEO).sheetCount)
        assertTrue(GalleryFilter(quick = GalleryQuickFilter.VIDEO).isActive)
        assertFalse(GalleryFilter().isActive)
        val cleared = f.copy(state = GalleryStateFilter.LISTED).clearSheet()
        assertEquals(GalleryFilter(quick = GalleryQuickFilter.URGENT), cleared)
        assertEquals(0, cleared.sheetCount)
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
