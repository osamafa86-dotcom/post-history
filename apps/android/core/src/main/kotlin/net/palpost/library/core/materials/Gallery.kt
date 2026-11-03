package net.palpost.library.core.materials

import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.MaterialType
import net.palpost.library.core.send.ArabicFold
import net.palpost.library.core.send.MaterialTagRules
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// The «My materials» gallery (design-brief.md §5.3, reporter-v2.md «موادي», frames 07–07c; ADR 0089): newest first, grouped by
// coverage title or by type, with the quick chips and the «View and filters» sheet (ADR 0106). Pure logic, tested on the JVM;
// the same rules as iOS (`MaterialGallery`).

/** Video or photo, as the reporter sees it in the gallery. */
enum class MediaKind { VIDEO, PHOTO }

/** The material's first coverage type in the contract's order: its group in grouping by type, its sub-line in grouping by title. */
val Material.primaryType: MaterialType? get() = MaterialType.entries.firstOrNull { it in materialTypes }

/** «Needs action»: the supervisor asked for changes, or the technical track failed. */
val Material.needsAction: Boolean get() = editorialState.value == "needs_changes" || technicalState.value == "failed"

object MaterialMedia {
    /**
     * Video or photo: the original's type on the server, then the phone row's, then a moving derivative or a duration, then the
     * coverage type «photos» alone. What cannot be told is a video (most of what reporters send).
     */
    fun kind(m: Material, localMimeType: String? = null): MediaKind {
        for (mime in listOf(m.files.firstOrNull { it.kind == MaterialFile.Kind.original }?.mimeType, localMimeType)) {
            val t = mime?.lowercase()?.takeIf { it.isNotEmpty() } ?: continue
            if (t.startsWith("image/")) return MediaKind.PHOTO
            if (t.startsWith("video/")) return MediaKind.VIDEO
        }
        if (m.files.any { it.kind == MaterialFile.Kind.proxy || it.kind == MaterialFile.Kind.hls || (it.durationMs ?: 0) > 0 }) return MediaKind.VIDEO
        if (m.materialTypes == setOf(MaterialType.photos)) return MediaKind.PHOTO
        return MediaKind.VIDEO
    }

    /** The video's length on the server: the original, then the stream, then the light copy; the first positive one. */
    fun durationMs(m: Material): Long? {
        for (k in listOf(MaterialFile.Kind.original, MaterialFile.Kind.hls, MaterialFile.Kind.proxy)) {
            m.files.firstOrNull { it.kind == k && (it.durationMs ?: 0) > 0 }?.durationMs?.let { return it }
        }
        return null
    }

    /** «1:42» or «1:02:03». */
    fun clock(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        return if (total >= 3600) "%d:%02d:%02d".format(total / 3600, (total % 3600) / 60, total % 60) else "%d:%02d".format(total / 60, total % 60)
    }
}

/** The coverage title: the title without a send's ` (i/N)` suffix (ADR 0082), normalised, keyed by folded Arabic matching. */
object CoverageTitle {
    fun display(title: String): String {
        val normalized = MaterialTagRules.normalize(title)
        val stripped = MaterialTagRules.normalize(stripBatchSuffix(normalized))
        return stripped.ifEmpty { normalized }
    }

    fun key(title: String): String = ArabicFold.key(display(title))

    /** ` (i/N)` at the end in ASCII digits, 1 ≤ i ≤ N and N ≥ 2; anything else is part of the title. */
    fun stripBatchSuffix(title: String): String {
        if (!title.endsWith(")")) return title
        val open = title.lastIndexOf(" (")
        if (open < 0) return title
        val parts = title.substring(open + 2, title.length - 1).split('/')
        if (parts.size != 2 || parts.any { p -> p.isEmpty() || p.length > 3 || p.any { it !in '0'..'9' } }) return title
        val i = parts[0].toInt()
        val n = parts[1].toInt()
        if (n < 2 || i !in 1..n) return title
        return title.substring(0, open)
    }
}

enum class GalleryGrouping { COVERAGE, TYPE }

/**
 * The quick chips above the gallery, as in frame 07 and on iOS: all · video · photos · urgent. «Needs action», a chip while the
 * sheet was missing (ADR 0095), is a status in the sheet now (ADR 0106).
 */
enum class GalleryQuickFilter { ALL, VIDEO, PHOTO, URGENT }

fun GalleryQuickFilter.matches(m: Material, kind: MediaKind): Boolean = when (this) {
    GalleryQuickFilter.ALL -> true
    GalleryQuickFilter.VIDEO -> kind == MediaKind.VIDEO
    GalleryQuickFilter.PHOTO -> kind == MediaKind.PHOTO
    GalleryQuickFilter.URGENT -> m.priority.value == "urgent"
}

/** The date range, by the send date (`created_at`, the list's own order) and the phone's calendar days (ADR 0089). */
enum class GalleryDateRange(internal val daysBack: Long?) { ANY(null), TODAY(0), WEEK(6), MONTH(29) }

/**
 * The status filter in the words of the three tracks, each on its own track (the states never merge): needs action (changes
 * asked or a technical failure) · processing (technical) · in review · approved · rejected (editorial) · listed (rights).
 */
enum class GalleryStateFilter { NEEDS_ACTION, PROCESSING, IN_REVIEW, APPROVED, REJECTED, LISTED }

/**
 * What the gallery shows: the quick chip, and the «View and filters» sheet's date range, coverage type and status (ADR 0106; the
 * same filters as iOS `GalleryFilter`). Grouping is chosen in the sheet too, but it is a view, not a filter.
 */
data class GalleryFilter(
    val quick: GalleryQuickFilter = GalleryQuickFilter.ALL,
    val dateRange: GalleryDateRange = GalleryDateRange.ANY,
    val coverageType: MaterialType? = null,
    val state: GalleryStateFilter? = null,
) {
    /** What is set in the sheet; the chips show above the gallery, so the sheet's button does not count them. */
    val sheetCount: Int
        get() = (if (dateRange == GalleryDateRange.ANY) 0 else 1) + (if (coverageType == null) 0 else 1) + (if (state == null) 0 else 1)

    val isActive: Boolean get() = quick != GalleryQuickFilter.ALL || sheetCount > 0

    /** The sheet's «Clear filters»: the chip above the gallery stays as it is. */
    fun clearSheet(): GalleryFilter = copy(dateRange = GalleryDateRange.ANY, coverageType = null, state = null)

    fun matches(m: Material, kind: MediaKind, nowMs: Long, zone: ZoneId): Boolean {
        if (!quick.matches(m, kind)) return false
        if (coverageType != null && coverageType !in m.materialTypes) return false
        if (state != null && !GalleryStates.matches(m, state)) return false
        return GalleryStates.within(dateRange, m.createdAt.toInstant().toEpochMilli(), nowMs, zone)
    }
}

object GalleryStates {
    private val APPROVED = setOf("accepted", "in_production", "final_review", "published")

    /**
     * Each status on its own track, by the contract's values and as the badges read them (iOS `MaterialStatus.signalTone`):
     * processing is a technical state neither verified nor failed; in review is an editorial state neither approved nor rejected
     * (changes asked included, as its badge says); listed is `sellable` alone.
     */
    fun matches(m: Material, state: GalleryStateFilter): Boolean = when (state) {
        GalleryStateFilter.NEEDS_ACTION -> m.needsAction
        GalleryStateFilter.PROCESSING -> m.technicalState.value != "verified" && m.technicalState.value != "failed"
        GalleryStateFilter.IN_REVIEW -> m.editorialState.value !in APPROVED && m.editorialState.value != "rejected"
        GalleryStateFilter.APPROVED -> m.editorialState.value in APPROVED
        GalleryStateFilter.REJECTED -> m.editorialState.value == "rejected"
        GalleryStateFilter.LISTED -> m.rightsState.value == "sellable"
    }

    /** From the start of the phone's day N days back; a date ahead of the phone's clock (a late clock) is within every range. */
    fun within(range: GalleryDateRange, epochMs: Long, nowMs: Long, zone: ZoneId): Boolean {
        val days = range.daysBack ?: return true
        val start = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().minusDays(days).atStartOfDay(zone).toInstant().toEpochMilli()
        return epochMs >= start
    }
}

/** A group: its heading, its newest material (orders the groups and dates the sub-line), and its materials newest first. */
data class GallerySection(
    val id: String,
    /** The coverage title without the send's suffix, when grouped by title. */
    val coverage: String?,
    /** The coverage type, when grouped by type (null for a material with no known type). */
    val type: MaterialType?,
    val newestEpochMs: Long,
    val primaryType: MaterialType?,
    val materials: List<Material>,
)

/** The group's day in its sub-line. */
sealed interface GalleryDay {
    data object Today : GalleryDay
    data object Yesterday : GalleryDay
    data class On(val date: LocalDate) : GalleryDay

    companion object {
        fun of(epochMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): GalleryDay {
            val d = java.time.Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()
            val today = java.time.Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
            return when (d) { today -> Today; today.minusDays(1) -> Yesterday; else -> On(d) }
        }
    }
}

object MaterialGallery {
    /** The materials after the filter, newest first, in groups ordered by their newest material. */
    fun sections(
        items: List<Material>, grouping: GalleryGrouping, filter: GalleryFilter = GalleryFilter(), nowMs: Long = System.currentTimeMillis(),
        zone: ZoneId = ZoneId.systemDefault(), kind: (Material) -> MediaKind,
    ): List<GallerySection> {
        val visible = items.withIndex().filter { filter.matches(it.value, kind(it.value), nowMs, zone) }
            .sortedWith(compareByDescending<IndexedValue<Material>> { it.value.createdAt }.thenBy { it.index }).map { it.value }
        val groups = LinkedHashMap<String, MutableList<Material>>()
        for (m in visible) groups.getOrPut(groupId(m, grouping)) { ArrayList() }.add(m)
        return groups.map { (id, members) ->
            val first = members.first()
            GallerySection(
                id = id,
                coverage = if (grouping == GalleryGrouping.COVERAGE) CoverageTitle.display(first.title) else null,
                type = if (grouping == GalleryGrouping.TYPE) first.primaryType else null,
                newestEpochMs = first.createdAt.toInstant().toEpochMilli(),
                primaryType = first.primaryType,
                materials = members,
            )
        }
    }

    fun groupId(m: Material, grouping: GalleryGrouping): String = when (grouping) {
        GalleryGrouping.COVERAGE -> "coverage:" + CoverageTitle.key(m.title)
        GalleryGrouping.TYPE -> "type:" + (m.primaryType?.value ?: "none")
    }
}

/**
 * Receipts waiting for their owner (ADR 0093, iOS `ReceiptInbox`): a receipt for an account other than the signed-in one (or with
 * nobody signed in) is not shown but waits until its owner signs in; a receipt on screen at sign-out goes back to waiting. Memory only.
 */
class ReceiptInbox<T> {
    private data class Entry<T>(val target: T, val owner: String?)

    private val waiting = ArrayList<Entry<T>>()

    val count: Int get() = synchronized(waiting) { waiting.size }

    /** A receipt arrived: returned to show now if it is the signed-in account's, else it waits (null). */
    fun arrive(target: T, owner: String?, scope: net.palpost.library.core.upload.AccountScope): T? {
        if (scope.owns(owner)) return target
        hold(target, owner)
        return null
    }

    /** Waits for its owner; never twice. */
    fun hold(target: T, owner: String?) = synchronized(waiting) {
        if (waiting.none { it.target == target }) waiting.add(Entry(target, owner))
    }

    /** The oldest receipt waiting for the signed-in account, taken out of the waiting list; nothing for anyone else. */
    fun next(scope: net.palpost.library.core.upload.AccountScope): T? = synchronized(waiting) {
        val i = waiting.indexOfFirst { scope.owns(it.owner) }
        if (i < 0) null else waiting.removeAt(i).target
    }

    /** The emergency wipe and revocation: nothing waits for anyone. */
    fun removeAll() = synchronized(waiting) { waiting.clear() }
}
