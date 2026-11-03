package net.palpost.library.ui.material

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialType
import net.palpost.library.core.materials.GalleryDateRange
import net.palpost.library.core.materials.GalleryDay
import net.palpost.library.core.materials.GalleryFilter
import net.palpost.library.core.materials.GalleryGrouping
import net.palpost.library.core.materials.GalleryQuickFilter
import net.palpost.library.core.materials.GalleryStateFilter
import net.palpost.library.core.materials.LocalOriginals
import net.palpost.library.core.materials.LocalRecord
import net.palpost.library.core.materials.MaterialGallery
import net.palpost.library.core.materials.MaterialMedia
import net.palpost.library.core.materials.MediaKind
import net.palpost.library.core.materials.PlaybackSourcePolicy
import net.palpost.library.core.materials.PreviewSource
import net.palpost.library.core.materials.SignedUrlLease
import net.palpost.library.core.materials.isSensitive
import net.palpost.library.core.upload.AccountScope
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.materialTypeLabel
import net.palpost.library.ui.theme.EmptyState
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.InlineAlert
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Track
import net.palpost.library.ui.theme.TrackBadge
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlChip
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

/** The phone's queue rows as the source rules need them: the signed-in account's own, with their copy still on the phone. */
fun localRecords(rows: List<UploadTaskEntity>, scope: AccountScope): List<LocalRecord> = rows.filter { scope.owns(it.ownerAccount) }.map {
    LocalRecord(it.id, it.materialId, it.kind, it.sha256, UploadState.valueOf(it.state), it.createdAtEpochMs, it.mimeType, it.fileUri)
}

/** A row's copy is on the phone: not deleted or let go after its receipt, and this app still holds its read grant. */
fun hasLocalCopy(context: Context, rows: List<UploadTaskEntity>): (LocalRecord) -> Boolean {
    val granted = context.contentResolver.persistedUriPermissions.filter { it.isReadPermission }.map { it.uri.toString() }.toSet()
    val handled = rows.filter { it.localCopyHandled }.map { it.id }.toSet()
    return { r -> r.id !in handled && r.uri in granted }
}

class MyMaterialsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    val state = container.materials.state
    val rows: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private val _grouping = MutableStateFlow(if (container.settings.galleryByType) GalleryGrouping.TYPE else GalleryGrouping.COVERAGE)
    val grouping: StateFlow<GalleryGrouping> = _grouping
    // The filters are this screen's while it lives (as on iOS); the grouping is a view preference kept on the phone.
    private val _filter = MutableStateFlow(GalleryFilter())
    val filter: StateFlow<GalleryFilter> = _filter

    fun group(g: GalleryGrouping) { _grouping.value = g; container.settings.galleryByType = g == GalleryGrouping.TYPE }
    fun setFilter(f: GalleryFilter) { _filter.value = f }
    fun quick(q: GalleryQuickFilter) = _filter.update { it.copy(quick = q) }

    /** Pull to refresh alone returns the gallery to its top. */
    fun refresh() = viewModelScope.launch { runCatching { container.materials.refresh() } }

    /** Showing (and coming back from a detail) and the 30 s poll merge the first page and keep the place. */
    suspend fun poll() {
        runCatching { container.materials.refreshHead(minAgeMs = POLL_MS) }
        while (true) { delay(POLL_MS); runCatching { container.materials.refreshHead() } }
    }

    /** Asked by the gallery's end row; the request belongs to the view model, so the row leaving the screen does not cancel it. */
    fun loadMoreIfNeeded(retry: Boolean = false) {
        if (!state.value.pages.wantsNextPage(pending = container.materials.nextPagePending, retry = retry)) return
        viewModelScope.launch { runCatching { container.materials.loadMore() } }
    }

    private companion object { const val POLL_MS = 30_000L }
}

/**
 * 07 · My materials as a gallery (ADR 0089 on Android): cards 9:16 in three columns, newest first, grouped by coverage title or by
 * type, with the quick chips in one row that scrolls and the «View and filters» sheet behind the top bar's button, which counts
 * what is set in it (ADR 0106). A sensitive material shows no cloud preview: a shield and «processed on the phone» over its phone
 * thumbnail, small and blurred. The three states are three badges, never one.
 */
@Composable
fun MyMaterialsScreen(container: AppContainer, onBack: () -> Unit, onNewMaterial: () -> Unit, onOpen: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: MyMaterialsViewModel = viewModel(factory = viewModelFactory { initializer { MyMaterialsViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val grouping by vm.grouping.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    val scope by container.scope.collectAsStateWithLifecycle()
    var showOptions by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (s.items.isEmpty()) vm.refresh(); vm.poll() }
    val context = LocalContext.current
    val records = localRecords(rows, scope)
    val hasCopy = hasLocalCopy(context, rows)
    val sections = MaterialGallery.sections(s.items, grouping, filter) { m -> MaterialMedia.kind(m, records.firstOrNull { it.materialId == m.id.toString() }?.mimeType) }
    val wideText = LocalConfiguration.current.fontScale >= 1.5f

    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.materials_title), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.action_back), onBack, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                actions = { OptionsButton(filter.sheetCount, { showOptions = true }, Modifier.padding(horizontal = VlSpace.s2)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = s.loading && s.items.isEmpty(), onRefresh = vm::refresh, modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(if (wideText) 2 else 3),
                contentPadding = PaddingValues(horizontal = VlSpace.s4, vertical = VlSpace.s3),
                horizontalArrangement = Arrangement.spacedBy(VlSpace.s3),
                verticalArrangement = Arrangement.spacedBy(VlSpace.s3),
                modifier = Modifier.fillMaxSize(),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "chips") { QuickChips(filter.quick, vm::quick) }
                if (s.pages.failed && s.items.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }, key = "stale") {
                    InlineAlert(Tone.NEUTRAL, stringResource(R.string.a4_stale, s.lastUpdatedEpochMs?.let { relative(it) } ?: "—")) { GhostButton(stringResource(R.string.materials_refresh), vm::refresh) }
                }
                val settled = !s.loading && (s.pages.reachedEnd || s.pages.failed)
                if (s.items.isEmpty() && s.pages.started && !s.loading) item(span = { GridItemSpan(maxLineSpan) }, key = "empty") {
                    EmptyState(Icons.Outlined.PhotoLibrary, stringResource(R.string.gallery_empty_title), stringResource(R.string.gallery_empty_body)) {
                        PrimaryButton(stringResource(R.string.home_send), onNewMaterial)
                    }
                } else if (s.items.isEmpty() && s.pages.failed) item(span = { GridItemSpan(maxLineSpan) }, key = "error") {
                    InlineAlert(Tone.BAD, stringResource(R.string.gallery_load_failed)) { GhostButton(stringResource(R.string.action_retry), vm::refresh) }
                } else if (sections.isEmpty() && s.items.isNotEmpty() && settled) item(span = { GridItemSpan(maxLineSpan) }, key = "nomatch") {
                    EmptyState(Icons.Outlined.Category, stringResource(R.string.gallery_no_match), "") {
                        OutlineButton(stringResource(R.string.gallery_clear_filters), { vm.setFilter(GalleryFilter()) }, small = true)
                    }
                }
                for (section in sections) {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "h-" + section.id) { SectionHeader(section, grouping) }
                    items(section.materials, key = { it.id }) { m ->
                        val local = LocalOriginals.find(m, records, hasCopy)
                        MediaCard(container, m, PlaybackSourcePolicy.thumbnail(m, local), showTitle = grouping == GalleryGrouping.TYPE, onClick = { onOpen(m.id.toString()) })
                    }
                }
                // The end row asks for the next page; its key is the pages' progress, so it asks once per page and never spins.
                if (!s.pages.reachedEnd && s.pages.started) item(span = { GridItemSpan(maxLineSpan) }, key = "end-" + s.pages.cursor + s.pages.failed) {
                    if (s.pages.failed) GhostButton(stringResource(R.string.materials_more), { vm.loadMoreIfNeeded(retry = true) })
                    else LaunchedEffect(s.pages.cursor, sections.size) { vm.loadMoreIfNeeded() }
                }
            }
        }
    }
    if (showOptions) GalleryOptionsSheet(grouping, vm::group, filter, vm::setFilter, onDone = { showOptions = false })
}

/** The top bar's «View and filters» button, with a badge counting what is set in the sheet; TalkBack reads the count too. */
@Composable
private fun OptionsButton(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val name = stringResource(R.string.gallery_options)
    val label = if (count > 0) stringResource(R.string.gallery_options_with_count, name, pluralStringResource(R.plurals.gallery_options_active, count, count)) else name
    BadgedBox(
        badge = { if (count > 0) Badge(containerColor = Vl.colors.actionPrimary, contentColor = Vl.colors.textOnBrand) { Text(count.toString(), modifier = Modifier.clearAndSetSemantics {}) } },
        modifier = modifier,
    ) {
        VlIconButton(Icons.Outlined.Tune, label, onClick)
    }
}

/** The quick chips in one row that scrolls sideways and never wraps (frame 07). */
@Composable
private fun QuickChips(current: GalleryQuickFilter, onPick: (GalleryQuickFilter) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        for (q in GalleryQuickFilter.entries) VlChip(stringResource(quickLabel(q)), current == q, { onPick(q) })
    }
}

private fun quickLabel(q: GalleryQuickFilter) = when (q) {
    GalleryQuickFilter.ALL -> R.string.gallery_quick_all
    GalleryQuickFilter.VIDEO -> R.string.gallery_quick_video
    GalleryQuickFilter.PHOTO -> R.string.gallery_quick_photo
    GalleryQuickFilter.URGENT -> R.string.gallery_quick_urgent
}

private fun dateLabel(r: GalleryDateRange) = when (r) {
    GalleryDateRange.ANY -> R.string.gallery_date_any
    GalleryDateRange.TODAY -> R.string.gallery_today
    GalleryDateRange.WEEK -> R.string.gallery_date_week
    GalleryDateRange.MONTH -> R.string.gallery_date_month
}

private fun stateLabel(s: GalleryStateFilter) = when (s) {
    GalleryStateFilter.NEEDS_ACTION -> R.string.gallery_state_needs_action
    GalleryStateFilter.PROCESSING -> R.string.gallery_state_processing
    GalleryStateFilter.IN_REVIEW -> R.string.gallery_state_in_review
    GalleryStateFilter.APPROVED -> R.string.gallery_state_approved
    GalleryStateFilter.REJECTED -> R.string.gallery_state_rejected
    GalleryStateFilter.LISTED -> R.string.gallery_state_listed
}

/**
 * The «View and filters» sheet (ADR 0106, iOS `GalleryOptionsSheet`): grouping (by coverage title or by type), date, coverage type
 * and status, each a group of chips under its heading; the selected one is dark ink with the «selected» state. Every change applies
 * at once behind the sheet; «Clear filters» shows when something is set and leaves the quick chip and the grouping alone. The sheet
 * is a window of this activity, so it keeps the secure flag (no screenshot, no recording).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GalleryOptionsSheet(
    grouping: GalleryGrouping, onGrouping: (GalleryGrouping) -> Unit, filter: GalleryFilter, onFilter: (GalleryFilter) -> Unit, onDone: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    ModalBottomSheet(onDismissRequest = onDone, sheetState = sheet, containerColor = Vl.colors.bgBase) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = VlSpace.s5).padding(bottom = VlSpace.s6),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s6),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.gallery_options), style = Vl.text.headline, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f).semantics { heading() })
                GhostButton(stringResource(R.string.gallery_done), onDone)
            }
            OptionGroup(stringResource(R.string.gallery_grouping)) {
                VlChip(stringResource(R.string.gallery_group_by_title), grouping == GalleryGrouping.COVERAGE, { onGrouping(GalleryGrouping.COVERAGE) })
                VlChip(stringResource(R.string.gallery_group_by_type), grouping == GalleryGrouping.TYPE, { onGrouping(GalleryGrouping.TYPE) })
            }
            OptionGroup(stringResource(R.string.gallery_date)) {
                for (r in GalleryDateRange.entries) VlChip(stringResource(dateLabel(r)), filter.dateRange == r, { onFilter(filter.copy(dateRange = r)) })
            }
            OptionGroup(stringResource(R.string.gallery_type)) {
                VlChip(stringResource(R.string.gallery_type_any), filter.coverageType == null, { onFilter(filter.copy(coverageType = null)) })
                for (t in MaterialType.entries) VlChip(materialTypeLabel(t), filter.coverageType == t, { onFilter(filter.copy(coverageType = t)) })
            }
            OptionGroup(stringResource(R.string.gallery_state)) {
                VlChip(stringResource(R.string.gallery_state_any), filter.state == null, { onFilter(filter.copy(state = null)) })
                for (st in GalleryStateFilter.entries) VlChip(stringResource(stateLabel(st)), filter.state == st, { onFilter(filter.copy(state = st)) })
            }
            if (filter.sheetCount > 0) OutlineButton(stringResource(R.string.gallery_clear_filters), { onFilter(filter.clearSheet()) }, small = true)
        }
    }
}

/** A heading and its chips, wrapping onto as many lines as the language and the font size need. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionGroup(title: String, chips: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        SectionTitle(title)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) { chips() }
    }
}

/** The group's heading and its sub-line «type · day · N items» (by title) or «day · N items» (by type). */
@Composable
private fun SectionHeader(section: net.palpost.library.core.materials.GallerySection, grouping: GalleryGrouping) {
    val day = when (val d = GalleryDay.of(section.newestEpochMs, System.currentTimeMillis())) {
        GalleryDay.Today -> stringResource(R.string.gallery_today)
        GalleryDay.Yesterday -> stringResource(R.string.gallery_yesterday)
        is GalleryDay.On -> DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(LocalConfiguration.current.locales[0]).format(d.date)
    }
    val count = pluralStringResource(R.plurals.receipt_items, section.materials.size, section.materials.size)
    Column(Modifier.padding(top = VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
        val title = if (grouping == GalleryGrouping.COVERAGE) section.coverage.orEmpty() else section.type?.let { materialTypeLabel(it) } ?: stringResource(R.string.gallery_type_other)
        Text(title, style = Vl.text.headline, color = Vl.colors.textPrimary, maxLines = 2, modifier = Modifier.semantics { heading() })
        val sub = listOfNotNull(if (grouping == GalleryGrouping.COVERAGE) section.primaryType?.let { materialTypeLabel(it) } else null, day, count)
        Text(sub.joinToString(" · "), style = Vl.text.caption, color = Vl.colors.textSecondary)
    }
}

/**
 * `Media card`: 9:16 with its picture, its kind's icon at the start of the top edge, its length, and the three states. TalkBack
 * reads the title, the kind, the length, «sensitive», then each track's state.
 */
@Composable
private fun MediaCard(container: AppContainer, m: Material, preview: PreviewSource, showTitle: Boolean, onClick: () -> Unit) {
    val kind = MaterialMedia.kind(m)
    val duration = MaterialMedia.durationMs(m)
    val sensitive = m.isSensitive
    val sensitiveWord = stringResource(R.string.sensitive_badge)
    val kindWord = stringResource(if (kind == MediaKind.PHOTO) R.string.gallery_kind_photo else R.string.gallery_kind_video)
    val tech = stringResource(technical(m.technicalState))
    val ed = stringResource(editorial(m.editorialState))
    val rt = stringResource(rights(m.rightsState))
    val a11y = listOfNotNull(
        m.title, kindWord, duration?.let { MaterialMedia.clock(it) }, if (sensitive) sensitiveWord else null,
        stringResource(R.string.material_state_technical) + ": " + tech, stringResource(R.string.material_state_editorial) + ": " + ed,
        stringResource(R.string.material_state_rights) + ": " + rt,
    ).joinToString("، ")
    Column(Modifier.clip(RoundedCornerShape(VlRadius.sm)).clickable(onClick = onClick).semantics(mergeDescendants = true) { contentDescription = a11y }, verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        Box(Modifier.fillMaxWidth().aspectRatio(9f / 16f).clip(RoundedCornerShape(VlRadius.sm)).background(Vl.colors.bgSunken)) {
            Thumbnail(container, m.id, preview, concealed = sensitive, kind = kind)
            Icon(if (kind == MediaKind.PHOTO) Icons.Outlined.Image else Icons.Outlined.Movie, contentDescription = null, tint = Color.White, modifier = Modifier.align(Alignment.TopStart).padding(VlSpace.s2).size(VlIcon.sm))
            if (duration != null && kind == MediaKind.VIDEO) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Text(MaterialMedia.clock(duration), style = Vl.text.caption, color = Color.White, modifier = Modifier.align(Alignment.BottomEnd).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(VlRadius.chip)).padding(horizontal = VlSpace.s2))
            }
            if (sensitive) SensitiveMark(Modifier.align(Alignment.Center))
        }
        if (showTitle) Text(m.title, style = Vl.text.caption, color = Vl.colors.textPrimary, maxLines = 2)
        TrackBadge(Track.TECHNICAL, MaterialTimeline.technicalTone(m.technicalState.value), tech, stringResource(R.string.material_state_technical))
        TrackBadge(Track.EDITORIAL, MaterialTimeline.editorialTone(m.editorialState.value), ed, stringResource(R.string.material_state_editorial))
        TrackBadge(Track.RIGHTS, MaterialTimeline.rightsTone(m.rightsState.value), rt, stringResource(R.string.material_state_rights))
    }
}

/** 07c's mark: a shield and «no cloud preview · processed on the phone». */
@Composable
fun SensitiveMark(modifier: Modifier = Modifier) {
    Column(modifier.padding(VlSpace.s2), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
        Icon(Icons.Outlined.Shield, contentDescription = null, tint = Color.White, modifier = Modifier.size(VlIcon.md))
        Text(stringResource(R.string.sensitive_no_cloud), style = Vl.text.caption, color = Color.White, maxLines = 3)
    }
}

/**
 * A picture from the phone or a verified thumbnail, from memory only. Concealed, it is loaded at 48 px and shown blurred (and
 * darkened) so nobody looking at the phone sees it; below Android 12, which has no blur, the 48 px picture is stretched without
 * smoothing, which hides it as well.
 */
@Composable
fun Thumbnail(container: AppContainer, materialId: UUID?, preview: PreviewSource, concealed: Boolean, kind: MediaKind, modifier: Modifier = Modifier, iconSize: androidx.compose.ui.unit.Dp = VlIcon.lg) {
    val context = LocalContext.current
    val px = if (concealed) 48 else 320
    val bitmap by produceState<ImageBitmap?>(null, preview, concealed) {
        value = when (preview) {
            is PreviewSource.Local -> container.thumbnails.local(context, preview.original.uri, px)
            is PreviewSource.Remote -> if (materialId == null) null else container.thumbnails.remote(preview.fileId, px) {
                runCatching { SignedUrlLease.of(container.materialsApi.getMaterialFileDownloadUrl(materialId, UUID.fromString(preview.fileId))) }.getOrNull()
            }
            PreviewSource.Unavailable -> null
        }
    }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val b = bitmap
        if (b != null) {
            val img = Modifier.fillMaxSize().then(if (concealed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Modifier.blur(16.dp) else Modifier)
            Image(b, contentDescription = null, contentScale = ContentScale.Crop, filterQuality = if (concealed) FilterQuality.None else FilterQuality.Low, modifier = img)
            if (concealed) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)))
        } else {
            Icon(if (kind == MediaKind.PHOTO) Icons.Outlined.Image else Icons.Outlined.Movie, contentDescription = null, tint = Vl.colors.textSecondary, modifier = Modifier.size(iconSize))
            if (concealed) Box(Modifier.fillMaxSize().background(Vl.colors.sensitivityBg.copy(alpha = 0.6f)))
        }
    }
}
