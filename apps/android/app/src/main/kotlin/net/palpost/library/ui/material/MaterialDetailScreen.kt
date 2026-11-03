package net.palpost.library.ui.material

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.Gavel
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.Transition
import net.palpost.library.api.models.TransitionRecord
import net.palpost.library.core.materials.LocalOriginalAbsence
import net.palpost.library.core.materials.LocalOriginals
import net.palpost.library.core.materials.MaterialMedia
import net.palpost.library.core.materials.MediaKind
import net.palpost.library.core.materials.PlaybackQuality
import net.palpost.library.core.materials.PlaybackSource
import net.palpost.library.core.materials.PlaybackSourcePolicy
import net.palpost.library.core.materials.PreviewSource
import net.palpost.library.core.materials.isSensitive
import net.palpost.library.core.materials.needsAction
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.send.LocalCopyPolicy
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.forms.materialTypeLabel
import net.palpost.library.ui.review.ReviewPolicy
import net.palpost.library.ui.theme.FieldLabel
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.PriorityBadge
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.SensitiveBadge
import net.palpost.library.ui.theme.Signal
import net.palpost.library.ui.theme.SolidButton
import net.palpost.library.ui.theme.StateBadge
import net.palpost.library.ui.theme.Track
import net.palpost.library.ui.theme.TrackBadge
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.priorityTone
import net.palpost.library.ui.theme.signalColor
import net.palpost.library.ui.theme.vlFieldColors
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

class MaterialDetailViewModel(private val container: AppContainer, private val id: UUID) : ViewModel() {
    data class Reply(val reason: String = "", val key: String = IdempotencyKey.generate(), val error: Int? = null, val sending: Boolean = false)

    val materials = container.materials.state
    val rows: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private val _transitions = MutableStateFlow<List<TransitionRecord>>(emptyList())
    val transitions: StateFlow<List<TransitionRecord>> = _transitions
    private val _reply = MutableStateFlow<Reply?>(null)
    val reply: StateFlow<Reply?> = _reply
    private val _missing = MutableStateFlow(false)
    val missing: StateFlow<Boolean> = _missing

    init { load() }

    fun load() = viewModelScope.launch {
        if (container.materials.reload(id) == null && materials.value.items.none { it.id == id }) _missing.value = true
        runCatching { container.materialsApi.listTransitions(id).items }.onSuccess { _transitions.value = it }
    }

    fun startReply() { _reply.value = Reply() }
    fun replyText(t: String) = _reply.update { it?.copy(reason = t, error = null) }
    fun cancelReply() { _reply.value = null }

    /** The answer to a request for changes: the reporter's own transition `needs_changes → reviewing`, idempotent and guarded by `If-Match`. */
    fun sendReply(m: Material) {
        val r = _reply.value ?: return
        val reason = ReviewPolicy.reason(r.reason) ?: return
        if (r.sending) return
        _reply.value = r.copy(sending = true)
        viewModelScope.launch {
            val result = runCatching { container.materialsApi.transitionMaterial(r.key, m.id, Transition(track = Transition.Track.editorial, to = "reviewing", reason = reason), ReviewPolicy.ifMatch(m)) }
            when (ReviewPolicy.outcomeOf(result.exceptionOrNull())) {
                ReviewPolicy.Outcome.DONE -> { _reply.value = null; load() }
                ReviewPolicy.Outcome.RETRY -> _reply.value = r.copy(sending = false, error = R.string.review_retry)
                ReviewPolicy.Outcome.STALE -> { _reply.value = null; load() }
                else -> _reply.value = r.copy(sending = false, error = R.string.review_failed)
            }
        }
    }
}

/**
 * 08 · the material (ADR 0089 on Android): the preview (the player, the photo, or «processing»), the title and its line, the three
 * states each explained in plain words with «since», the supervisor's note, the actions, the data, the files on the server and on
 * this phone, and the timeline of three tracks that never merge. A sensitive picture never shows by itself: it stays blurred until
 * the reporter taps «Play» or «Show the photo».
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MaterialDetailScreen(container: AppContainer, materialId: String, onBack: () -> Unit, onReceipt: (String) -> Unit, onReplacement: (String) -> Unit) {
    val id = UUID.fromString(materialId)
    val vm: MaterialDetailViewModel = viewModel(key = "detail-$materialId", factory = viewModelFactory { initializer { MaterialDetailViewModel(container, id) } })
    val snapshot by vm.materials.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val transitions by vm.transitions.collectAsStateWithLifecycle()
    val reply by vm.reply.collectAsStateWithLifecycle()
    val missing by vm.missing.collectAsStateWithLifecycle()
    val scope by container.scope.collectAsStateWithLifecycle()
    val m = snapshot.items.firstOrNull { it.id == id }
    var revealed by rememberSaveable { mutableStateOf(false) }
    var fullscreen by rememberSaveable { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf<Track?>(null) }
    val handoff = remember(materialId) { PlayerHandoff() }
    BackHandler(enabled = fullscreen) { fullscreen = false }
    val context = LocalContext.current
    val records = localRecords(rows, scope)
    val hasCopy = hasLocalCopy(context, rows)
    val local = m?.let { LocalOriginals.find(it, records, hasCopy) }
    val kind = m?.let { MaterialMedia.kind(it, local?.mimeType) } ?: MediaKind.VIDEO
    val source = m?.let { PlaybackSourcePolicy.player(it, local) } ?: PlaybackSource.Unavailable

    if (fullscreen && m != null && source != PlaybackSource.Unavailable) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            MaterialPlayer(container, m, source, fullscreen = true, onFullscreen = { fullscreen = it }, modifier = Modifier.fillMaxSize(), handoff = handoff)
        }
        return
    }
    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.detail_title), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.action_back), onBack, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
    ) { padding ->
        if (m == null) {
            Column(Modifier.fillMaxSize().padding(padding).padding(VlSpace.s5)) {
                Text(stringResource(if (missing) R.string.detail_missing else R.string.materials_loading), style = Vl.text.body, color = Vl.colors.textSecondary)
            }
            return@Scaffold
        }
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(VlSpace.s5), verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
            Preview(container, m, kind, source, local, revealed, handoff, onReveal = { revealed = true }, onFullscreen = { fullscreen = true }, absence = LocalOriginals.absence(m, records, hasCopy))
            Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                Text(m.title, style = Vl.text.title, color = Vl.colors.textPrimary, modifier = Modifier.semantics { heading() })
                val line = listOfNotNull(
                    m.governorate, day(m.createdAt), MaterialMedia.durationMs(m)?.let { MaterialMedia.clock(it) },
                    stringResource(if (kind == MediaKind.PHOTO) R.string.gallery_kind_photo else R.string.gallery_kind_video),
                )
                Text(line.joinToString(" · "), style = Vl.text.caption, color = Vl.colors.textSecondary)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                    if (m.priority.value != "normal") PriorityBadge(priorityLabel(m.priority), priorityTone(m.priority))
                    if (m.isSensitive) SensitiveBadge(stringResource(R.string.sensitive_badge))
                }
            }
            States(m, transitions, filter) { filter = if (filter == it) null else it }
            MaterialTimeline.supervisorNote(m, transitions)?.let { note ->
                VlCard(background = Vl.colors.sensitivityBg, border = Vl.colors.sensitivityBorder, gap = VlSpace.s2) {
                    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Edit, contentDescription = null, tint = Vl.colors.textPrimary, modifier = Modifier.size(VlIcon.md))
                        Text(stringResource(R.string.a4_supervisor_note), style = Vl.text.label, color = Vl.colors.textPrimary)
                    }
                    Text(note.reason, style = Vl.text.body, color = Vl.colors.textPrimary)
                }
            }
            // The actions follow the state.
            if (kind == MediaKind.VIDEO && source != PlaybackSource.Unavailable) OutlineButton(stringResource(R.string.detail_play_fullscreen), { revealed = true; handoff.playing = true; fullscreen = true }, leading = Icons.Outlined.Fullscreen)
            if (m.needsAction) SolidButton(stringResource(R.string.a4_replacement), { onReplacement(m.id.toString()) })
            if (m.editorialState.value == "needs_changes") OutlineButton(stringResource(R.string.a4_reply), vm::startReply)
            receiptRow(m, rows, scope)?.let { row -> GhostButton(stringResource(R.string.a4_show_receipt), { onReceipt(row.id) }) }
            Data(m)
            Files(m, rows.filter { scope.owns(it.ownerAccount) && it.materialId == m.id.toString() }, hasCopy, records)
            SectionTitle(stringResource(R.string.a4_timeline))
            val events = MaterialTimeline.events(transitions, filter)
            if (events.isEmpty()) Text(stringResource(R.string.review_history_empty), style = Vl.text.body, color = Vl.colors.textSecondary)
            Column { events.forEachIndexed { i, r -> Event(r, last = i == events.lastIndex) } }
        }
    }
    val r = reply
    if (r != null && m != null) AlertDialog(
        onDismissRequest = { if (!r.sending) vm.cancelReply() },
        title = { Text(stringResource(R.string.a4_reply), style = Vl.text.headline) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                Text(stringResource(R.string.a4_reply_hint), style = Vl.text.body)
                OutlinedTextField(value = r.reason, onValueChange = { if (it.length <= ReviewPolicy.REASON_MAX) vm.replyText(it) }, textStyle = Vl.text.body, minLines = 2, colors = vlFieldColors())
                r.error?.let { Text(stringResource(it), color = Vl.colors.stateDanger, style = Vl.text.caption) }
            }
        },
        confirmButton = { GhostButton(stringResource(R.string.a4_reply_send), { vm.sendReply(m) }, enabled = !r.sending && ReviewPolicy.reason(r.reason) != null) },
        dismissButton = { GhostButton(stringResource(R.string.review_cancel), vm::cancelReply, enabled = !r.sending) },
    )
}

/** «Show receipt» opens with the original's row the server verified or matched, else one still on its way; the owner's rows only. */
private fun receiptRow(m: Material, rows: List<UploadTaskEntity>, scope: net.palpost.library.core.upload.AccountScope): UploadTaskEntity? {
    val originals = rows.filter { it.materialId == m.id.toString() && it.kind == "original" && scope.owns(it.ownerAccount) }.sortedByDescending { it.createdAtEpochMs }
    return originals.firstOrNull { LocalCopyPolicy.mayDelete(UploadState.valueOf(it.state)) } ?: originals.firstOrNull { !UploadState.valueOf(it.state).terminal }
}

@Composable
private fun Preview(
    container: AppContainer, m: Material, kind: MediaKind, source: PlaybackSource, local: net.palpost.library.core.materials.LocalOriginal?,
    revealed: Boolean, handoff: PlayerHandoff, onReveal: () -> Unit, onFullscreen: () -> Unit, absence: LocalOriginalAbsence?,
) {
    val concealed = PlaybackSourcePolicy.conceals(m, revealed)
    val shape = RoundedCornerShape(VlRadius.md)
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(shape).background(Color.Black), contentAlignment = Alignment.Center) {
        when {
            kind == MediaKind.PHOTO -> {
                val still = PlaybackSourcePolicy.still(m, local, requested = revealed)
                if (concealed) {
                    Thumbnail(container, m.id, PlaybackSourcePolicy.thumbnail(m, local), concealed = true, kind = kind)
                    Reveal(stringResource(R.string.detail_show_photo), onReveal)
                } else if (still == PreviewSource.Unavailable) Processing(absence)
                else Thumbnail(container, m.id, still, concealed = false, kind = kind)
            }
            source == PlaybackSource.Unavailable -> Processing(absence)
            concealed -> {
                Thumbnail(container, m.id, PlaybackSourcePolicy.thumbnail(m, local), concealed = true, kind = kind)
                Reveal(stringResource(R.string.player_play)) { handoff.playing = true; onReveal() }
            }
            else -> MaterialPlayer(container, m, source, fullscreen = false, onFullscreen = { if (it) onFullscreen() }, modifier = Modifier.fillMaxSize(), handoff = handoff)
        }
    }
}

/** The sensitive mark and one tap that shows it. */
@Composable
private fun Reveal(label: String, onReveal: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        SensitiveMark()
        SolidButton(label, onReveal, leading = Icons.Outlined.Visibility, fullWidth = false)
    }
}

/** «Processing — shown when the copy is ready», and why the phone's copy is not shown. Never an error, never a blank. */
@Composable
private fun Processing(absence: LocalOriginalAbsence?) {
    Column(Modifier.padding(VlSpace.s4), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        Icon(Icons.Outlined.HourglassEmpty, contentDescription = null, tint = Color.White, modifier = Modifier.size(VlIcon.lg))
        Text(stringResource(R.string.detail_processing), style = Vl.text.headline, color = Color.White)
        val why = when (absence) {
            LocalOriginalAbsence.REMOVED_FROM_PHONE -> R.string.detail_absence_removed
            LocalOriginalAbsence.NOT_THE_VERIFIED_ORIGINAL -> R.string.detail_absence_not_verified
            else -> R.string.detail_absence_not_on_phone
        }
        Text(stringResource(why), style = Vl.text.caption, color = Color.White.copy(alpha = 0.8f))
    }
}

private data class StateRow(val name: Int, val word: Int, val tone: net.palpost.library.ui.theme.Tone, val explain: Int)

/** The three states, each in a row: the track, its plain explanation, «since» its last move, and its badge; a tap filters the timeline. */
@Composable
private fun States(m: Material, transitions: List<TransitionRecord>, filter: Track?, onTrack: (Track) -> Unit) {
    VlCard(gap = VlSpace.s3, padding = VlSpace.s4) {
        for ((i, t) in Track.entries.withIndex()) {
            if (i > 0) HorizontalDivider(color = Vl.colors.borderLine)
            val row = when (t) {
                Track.TECHNICAL -> StateRow(R.string.material_state_technical, technical(m.technicalState), MaterialTimeline.technicalTone(m.technicalState.value), technicalExplanation(m.technicalState.value))
                Track.EDITORIAL -> StateRow(R.string.material_state_editorial, editorial(m.editorialState), MaterialTimeline.editorialTone(m.editorialState.value), editorialExplanation(m.editorialState.value))
                Track.RIGHTS -> StateRow(R.string.material_state_rights, rights(m.rightsState), MaterialTimeline.rightsTone(m.rightsState.value), rightsExplanation(m.rightsState.value))
            }
            val since = MaterialTimeline.events(transitions, t).firstOrNull()?.occurredAt
            Row(
                Modifier.fillMaxWidth().heightIn(min = net.palpost.library.ui.theme.MinTouchTarget).clickable { onTrack(t) },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
                    Text(stringResource(row.name), style = Vl.text.label, color = if (filter == t) Vl.colors.textBrand else Vl.colors.textSecondary)
                    Text(stringResource(row.explain), style = Vl.text.body, color = Vl.colors.textPrimary)
                    since?.let { Text(stringResource(R.string.detail_since, dateTime(it)), style = Vl.text.caption, color = Vl.colors.textSecondary) }
                }
                TrackBadge(t, row.tone, stringResource(row.word), stringResource(row.name), selected = filter == t)
            }
        }
    }
}

/** Type, tags (read only), place, filming and sending times, receipt numbers (mono, left to right). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Data(m: Material) {
    VlCard(gap = VlSpace.s3, padding = VlSpace.s4) {
        DataRow(stringResource(R.string.send_field_type), m.materialTypes.map { materialTypeLabel(it) }.joinToString("، "))
        val tags = m.tags.orEmpty()
        if (tags.isNotEmpty()) {
            FieldLabel(stringResource(R.string.send_field_tags))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                for (t in tags) Text(t, style = Vl.text.chip, color = Vl.colors.textPrimary, modifier = Modifier.clip(RoundedCornerShape(VlRadius.chip)).background(Vl.colors.bgSunken).padding(horizontal = VlSpace.s3, vertical = VlSpace.s1))
            }
        }
        DataRow(stringResource(R.string.detail_place), m.governorate + " · " + m.city)
        m.shotAt?.let { DataRow(stringResource(R.string.detail_shot_at), dateTime(it)) }
        DataRow(stringResource(R.string.detail_sent_at), dateTime(m.createdAt))
        val numbers = m.files.mapNotNull { it.receiptNumber?.takeIf(String::isNotBlank) }.distinct()
        for (n in numbers) DataRow(stringResource(R.string.a3_receipt_label), n, mono = true)
    }
}

@Composable
private fun DataRow(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VlSpace.s4)) {
        Text(label, style = Vl.text.label, color = Vl.colors.textSecondary, modifier = Modifier.weight(0.4f))
        if (mono) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) { Text(value, style = Vl.text.receipt, color = Vl.colors.textPrimary, modifier = Modifier.weight(0.6f)) }
        else Text(value, style = Vl.text.body, color = Vl.colors.textPrimary, modifier = Modifier.weight(0.6f))
    }
}

/** The files on the server (kind, quality, size, length, state as a word and a tone) and the rows on this phone (stage, copy kept). */
@Composable
private fun Files(m: Material, phoneRows: List<UploadTaskEntity>, hasCopy: (net.palpost.library.core.materials.LocalRecord) -> Boolean, records: List<net.palpost.library.core.materials.LocalRecord>) {
    SectionTitle(stringResource(R.string.detail_files))
    VlCard(gap = VlSpace.s3, padding = VlSpace.s4) {
        FieldLabel(stringResource(R.string.detail_files_server))
        val order = listOf("original", "proxy", "hls", "audio", "thumbnail", "voice_note", "transcript", "captions", "shot_list")
        val files = m.files.sortedWith(compareBy<MaterialFile> { order.indexOf(it.kind.value).let { i -> if (i < 0) order.size else i } }.thenByDescending { it.createdAt })
        if (files.isEmpty()) Text(stringResource(R.string.detail_files_none), style = Vl.text.body, color = Vl.colors.textSecondary)
        for (f in files) {
            val quality = when (f.kind) {
                MaterialFile.Kind.original -> PlaybackQuality.Original
                MaterialFile.Kind.proxy -> PlaybackQuality.lightCopy(f)
                MaterialFile.Kind.hls -> PlaybackQuality.Adaptive
                else -> null
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(fileKind(f.kind)) + (quality?.takeIf { f.kind == MaterialFile.Kind.proxy }?.let { " · " + qualityWord(it) } ?: ""), style = Vl.text.body, color = Vl.colors.textPrimary)
                    val meta = listOfNotNull(f.sizeBytes?.let { FieldInput.describeBytes(it) }, f.durationMs?.takeIf { it > 0 }?.let { MaterialMedia.clock(it) })
                    if (meta.isNotEmpty()) Text(meta.joinToString(" · "), style = Vl.text.num, color = Vl.colors.textSecondary)
                }
                val signal = when (f.state) { MaterialFile.State.verified -> Signal.OK; MaterialFile.State.failed -> Signal.DANGER; MaterialFile.State.received -> Signal.BRAND; else -> Signal.MUTED }
                StateBadge(stringResource(fileState(f.state)), signal)
            }
        }
        if (phoneRows.isNotEmpty()) {
            HorizontalDivider(color = Vl.colors.borderLine)
            FieldLabel(stringResource(R.string.detail_files_phone))
            for (r in phoneRows.sortedByDescending { it.createdAtEpochMs }) {
                val record = records.firstOrNull { it.id == r.id }
                val kept = record != null && hasCopy(record)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                    Column(Modifier.weight(1f)) {
                        Text(net.palpost.library.ui.uploads.stageWord(r), style = Vl.text.body, color = Vl.colors.textPrimary)
                        Text(stringResource(if (kept) R.string.detail_copy_kept else R.string.detail_copy_gone), style = Vl.text.caption, color = Vl.colors.textSecondary)
                    }
                    if (r.state == UploadState.UPLOADING.name && r.sizeBytes > 0) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Text("${(r.bytesConfirmed * 100 / r.sizeBytes)}%", style = Vl.text.num, color = Vl.colors.textBrand)
                    }
                }
            }
        }
    }
}

/** One event: the track's icon and colour, a dot on a line, the change and its time. */
@Composable
private fun Event(r: TransitionRecord, last: Boolean) {
    val track = MaterialTimeline.trackOf(r)
    val color = signalColor(when (track) { Track.TECHNICAL -> Signal.BRAND; Track.EDITORIAL -> Signal.WARN; Track.RIGHTS -> Signal.MUTED })
    val name = stringResource(when (track) { Track.TECHNICAL -> R.string.material_state_technical; Track.EDITORIAL -> R.string.material_state_editorial; Track.RIGHTS -> R.string.material_state_rights })
    val label = stringResource(R.string.a4_event, name, stateLabel(r.track.value, r.to))
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(when (track) { Track.TECHNICAL -> Icons.Outlined.Movie; Track.EDITORIAL -> Icons.Outlined.Edit; Track.RIGHTS -> Icons.Outlined.Gavel }, contentDescription = null, tint = color, modifier = Modifier.size(VlIcon.md))
            Box(Modifier.size(VlSpace.s4).clip(CircleShape).background(color))
            if (!last) Box(Modifier.width(VlSpace.s1).height(VlSpace.s7).background(Vl.colors.borderLine))
        }
        Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s1), modifier = Modifier.padding(bottom = VlSpace.s4)) {
            Text(label, style = Vl.text.body, color = Vl.colors.textPrimary)
            if (track == Track.EDITORIAL && r.reason.isNotBlank()) Text(r.reason, style = Vl.text.caption, color = Vl.colors.textSecondary, maxLines = 3)
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) { Text(dateTime(r.occurredAt), style = Vl.text.num, color = Vl.colors.textSecondary) }
        }
    }
}

@Composable
private fun dateTime(t: OffsetDateTime): String =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(LocalConfiguration.current.locales[0]).format(t.atZoneSameInstant(ZoneId.systemDefault()))

@Composable
private fun day(t: OffsetDateTime): String {
    val now = java.time.LocalDate.now()
    val d = t.atZoneSameInstant(ZoneId.systemDefault()).toLocalDate()
    return when (d) {
        now -> stringResource(R.string.gallery_today)
        now.minusDays(1) -> stringResource(R.string.gallery_yesterday)
        else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(LocalConfiguration.current.locales[0]).format(d)
    }
}
