package net.palpost.library.ui.material

import android.app.Application
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
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
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.Transition
import net.palpost.library.api.models.TransitionRecord
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.review.ReviewPolicy
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.Overline
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.PriorityBadge
import net.palpost.library.ui.theme.StateBadge
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Track
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.icon
import net.palpost.library.ui.theme.priorityTone
import net.palpost.library.ui.theme.rememberReduceMotion
import net.palpost.library.ui.theme.trackAccent
import net.palpost.library.ui.theme.trackSubtle
import net.palpost.library.ui.theme.tokens.VlMotion
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

/**
 * A4 · My materials as a timeline (docs/design/specs/reporter.md): the reporter's own materials (the server scopes
 * `GET /materials`), each with its three states apart and one timeline of three track colours that never merge.
 */
class MyMaterialsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    enum class Tab { ALL, NEEDS_ACTION }

    data class Reply(val reason: String = "", val key: String = IdempotencyKey.generate(), val error: Int? = null, val sending: Boolean = false)

    data class UiState(
        val items: List<Material> = emptyList(),
        val nextCursor: String? = null,
        val loading: Boolean = false,
        val loaded: Boolean = false,
        val error: String? = null,
        /** Set when a refresh failed over data already shown: the list stays, with "not updated since". */
        val staleSinceMs: Long? = null,
        val updatedAtMs: Long? = null,
        val tab: Tab = Tab.ALL,
        val expandedId: UUID? = null,
        val transitions: Map<UUID, List<TransitionRecord>> = emptyMap(),
        val trackFilter: Track? = null,
        val receiptTask: Map<UUID, String> = emptyMap(),
        val reply: Reply? = null,
    ) {
        val needsActionCount: Int get() = items.count(MaterialTimeline::needsAction)
        val shown: List<Material> get() = if (tab == Tab.NEEDS_ACTION) items.filter(MaterialTimeline::needsAction) else items
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun refresh() = load(null)
    fun more() { _state.value.nextCursor?.let { load(it) } }

    private fun load(cursor: String?) {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val page = container.materialsApi.listMaterials(cursor = cursor, limit = PAGE)
                _state.update { s ->
                    val items = if (cursor == null) page.items else s.items + page.items
                    s.copy(items = items, nextCursor = page.nextCursor, loading = false, loaded = true, staleSinceMs = null, updatedAtMs = System.currentTimeMillis(),
                        expandedId = s.expandedId ?: items.firstOrNull()?.id)
                }
                _state.value.expandedId?.let { loadDetails(it) }
            } catch (e: Exception) {
                _state.update { s ->
                    if (s.loaded) s.copy(loading = false, staleSinceMs = s.staleSinceMs ?: s.updatedAtMs) else s.copy(loading = false, error = describeFailure(app, e))
                }
            }
        }
    }

    /** Polls every 30 s while the screen is in front (spec A4); pull to refresh does the same at once. */
    suspend fun poll() { while (true) { delay(30_000); refresh() } }

    fun tab(t: Tab) = _state.update { it.copy(tab = t) }

    fun toggle(m: Material) {
        val open = _state.value.expandedId != m.id
        _state.update { it.copy(expandedId = if (open) m.id else null, trackFilter = null) }
        if (open) loadDetails(m.id)
    }

    fun filter(t: Track) = _state.update { it.copy(trackFilter = if (it.trackFilter == t) null else t) }

    private fun loadDetails(id: UUID) = viewModelScope.launch {
        runCatching { container.materialsApi.listTransitions(id).items }.onSuccess { list -> _state.update { it.copy(transitions = it.transitions + (id to list)) } }
        container.database.uploads().receiptFor(id.toString())?.let { t -> _state.update { it.copy(receiptTask = it.receiptTask + (id to t.id)) } }
    }

    fun startReply() = _state.update { it.copy(reply = Reply()) }
    fun replyText(t: String) = _state.update { s -> s.copy(reply = s.reply?.copy(reason = t, error = null)) }
    fun cancelReply() = _state.update { it.copy(reply = null) }

    /**
     * The reporter's answer to a request for changes: the contract's own transition `needs_changes → reviewing`
     * on the editorial track, owned by the reporter, with the answer as its reason. Idempotent and guarded by
     * `If-Match`, so a retry after a cut is the same request and a stale view changes nothing.
     */
    fun sendReply(m: Material) {
        val r = _state.value.reply ?: return
        val reason = ReviewPolicy.reason(r.reason) ?: return
        if (r.sending) return
        _state.update { it.copy(reply = r.copy(sending = true)) }
        viewModelScope.launch {
            val result = runCatching {
                container.materialsApi.transitionMaterial(r.key, m.id, Transition(track = Transition.Track.editorial, to = "reviewing", reason = reason), ReviewPolicy.ifMatch(m))
            }
            when (ReviewPolicy.outcomeOf(result.exceptionOrNull())) {
                ReviewPolicy.Outcome.DONE -> {
                    val fresh = result.getOrNull()
                    _state.update { s -> s.copy(reply = null, items = if (fresh == null) s.items else s.items.map { if (it.id == fresh.id) fresh else it }) }
                    loadDetails(m.id)
                }
                ReviewPolicy.Outcome.RETRY -> _state.update { it.copy(reply = r.copy(sending = false, error = R.string.review_retry)) }
                ReviewPolicy.Outcome.STALE -> { _state.update { it.copy(reply = null) }; refresh() }
                else -> _state.update { it.copy(reply = r.copy(sending = false, error = R.string.review_failed)) }
            }
        }
    }

    private companion object { const val PAGE = 30L }
}

@Composable
fun MyMaterialsScreen(container: AppContainer, onBack: () -> Unit, onNewMaterial: () -> Unit, onReceipt: (String) -> Unit, onReplacement: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: MyMaterialsViewModel = viewModel(factory = viewModelFactory { initializer { MyMaterialsViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (s.items.isEmpty()) vm.refresh(); vm.poll() }

    Scaffold(
        containerColor = Vl.colors.bgCanvas,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.materials_title), style = Vl.text.headingH3) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = s.loading, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = VlSpace.s5, vertical = VlSpace.s4),
                verticalArrangement = Arrangement.spacedBy(VlSpace.s4),
            ) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                        FilterChip(selected = s.tab == MyMaterialsViewModel.Tab.ALL, onClick = { vm.tab(MyMaterialsViewModel.Tab.ALL) },
                            label = { Text(stringResource(R.string.a4_tab_all, s.items.size), style = Vl.text.labelMd) }, modifier = Modifier.height(VlSize.touchMin))
                        FilterChip(selected = s.tab == MyMaterialsViewModel.Tab.NEEDS_ACTION, onClick = { vm.tab(MyMaterialsViewModel.Tab.NEEDS_ACTION) },
                            label = { Text(stringResource(R.string.a4_tab_needs_action, s.needsActionCount), style = Vl.text.labelMd) }, modifier = Modifier.height(VlSize.touchMin))
                    }
                }
                s.staleSinceMs?.let { since -> item {
                    net.palpost.library.ui.theme.InlineAlert(Tone.NEUTRAL, stringResource(R.string.a4_stale, relative(since))) {
                        GhostButton(stringResource(R.string.materials_refresh), vm::refresh)
                    }
                } }
                s.error?.let { item { net.palpost.library.ui.theme.InlineAlert(Tone.BAD, it) { GhostButton(stringResource(R.string.action_retry), vm::refresh) } } }
                if (s.loaded && s.items.isEmpty()) item {
                    VlCard {
                        Text(stringResource(R.string.a4_empty), style = Vl.text.bodyMd, color = Vl.colors.textSecondary)
                        PrimaryButton(stringResource(R.string.home_new_material), onNewMaterial)
                    }
                }
                items(s.shown, key = { it.id }) { m ->
                    if (s.expandedId == m.id) Expanded(m, s, vm, onReceipt, onReplacement)
                    else Collapsed(m) { vm.toggle(m) }
                }
                if (s.nextCursor != null && !s.loading) item { GhostButton(stringResource(R.string.materials_more), vm::more, modifier = Modifier.fillMaxWidth()) }
            }
        }
    }

    val replying = s.reply
    val target = s.items.firstOrNull { it.id == s.expandedId }
    if (replying != null && target != null) {
        AlertDialog(
            onDismissRequest = { if (!replying.sending) vm.cancelReply() },
            title = { Text(stringResource(R.string.a4_reply), style = Vl.text.headingH4) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                    Text(stringResource(R.string.a4_reply_hint), style = Vl.text.bodySm)
                    OutlinedTextField(value = replying.reason, onValueChange = { if (it.length <= ReviewPolicy.REASON_MAX) vm.replyText(it) }, textStyle = Vl.text.bodyMd, minLines = 2)
                    replying.error?.let { Text(stringResource(it), color = Vl.colors.textDanger, style = Vl.text.bodySm) }
                }
            },
            confirmButton = { TextButton(onClick = { vm.sendReply(target) }, enabled = !replying.sending && ReviewPolicy.reason(replying.reason) != null) { Text(stringResource(R.string.a4_reply_send)) } },
            dismissButton = { TextButton(onClick = vm::cancelReply, enabled = !replying.sending) { Text(stringResource(R.string.review_cancel)) } },
        )
    }
}

@Composable
private fun Collapsed(m: Material, onClick: () -> Unit) {
    VlCard(modifier = Modifier.clickable(onClick = onClick), gap = VlSpace.s3) {
        Text(m.title, style = Vl.text.headingH4, color = Vl.colors.textPrimary, maxLines = 2)
        Badges(m, selected = null, onTrack = null)
    }
}

/** The three badges, always together and always technical → editorial → rights; they wrap, never clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Badges(m: Material, selected: Track?, onTrack: ((Track) -> Unit)?) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        val tech = stringResource(technical(m.technicalState))
        val ed = stringResource(editorial(m.editorialState))
        val rt = stringResource(rights(m.rightsState))
        StateBadge(Track.TECHNICAL, tech, MaterialTimeline.technicalTone(m.technicalState.value), stringResource(R.string.material_state_technical) + ": " + tech,
            onClick = onTrack?.let { { it(Track.TECHNICAL) } }, selected = selected == Track.TECHNICAL)
        StateBadge(Track.EDITORIAL, ed, MaterialTimeline.editorialTone(m.editorialState.value), stringResource(R.string.material_state_editorial) + ": " + ed,
            onClick = onTrack?.let { { it(Track.EDITORIAL) } }, selected = selected == Track.EDITORIAL)
        StateBadge(Track.RIGHTS, rt, MaterialTimeline.rightsTone(m.rightsState.value), stringResource(R.string.material_state_rights) + ": " + rt,
            onClick = onTrack?.let { { it(Track.RIGHTS) } }, selected = selected == Track.RIGHTS)
    }
}

@Composable
private fun Expanded(m: Material, s: MyMaterialsViewModel.UiState, vm: MyMaterialsViewModel, onReceipt: (String) -> Unit, onReplacement: (String) -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val transitions = s.transitions[m.id].orEmpty()
    VlCard(modifier = Modifier.animateContentSize(tween(if (reduceMotion) 0 else VlMotion.baseMs, easing = VlMotion.standard)), border = Vl.colors.borderStrong) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { vm.toggle(m) }) {
            PriorityBadge(priorityLabel(m.priority), priorityTone(m.priority))
            Text(m.title, style = Vl.text.headingH4, color = Vl.colors.textPrimary, maxLines = 3)
        }
        Badges(m, s.trackFilter, vm::filter)
        MaterialTimeline.supervisorNote(m, transitions)?.let { note ->
            VlCard(background = Vl.colors.toneAttentionBg, border = Vl.colors.toneAttentionBorder, gap = VlSpace.s2) {
                Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Edit, contentDescription = null, tint = Vl.colors.toneAttentionFg, modifier = Modifier.size(VlSize.iconMd))
                    Text(stringResource(R.string.a4_supervisor_note), style = Vl.text.labelMd, color = Vl.colors.toneAttentionFg)
                    Time(note)
                }
                Text(note.reason, style = Vl.text.bodySm, color = Vl.colors.textPrimary)
            }
        }
        Overline(stringResource(R.string.a4_timeline))
        val events = MaterialTimeline.events(transitions, s.trackFilter)
        if (events.isEmpty()) Text(stringResource(R.string.review_history_empty), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
        Column {
            events.forEachIndexed { i, r -> Event(r, last = i == events.lastIndex) }
        }
        // The primary action follows the state.
        when {
            m.editorialState.value == "needs_changes" -> {
                PrimaryButton(stringResource(R.string.a4_replacement), { onReplacement(m.id.toString()) })
                GhostButton(stringResource(R.string.a4_reply), vm::startReply)
            }
            m.technicalState.value == "verified" && m.editorialState.value != "published" ->
                s.receiptTask[m.id]?.let { taskId -> PrimaryButton(stringResource(R.string.a4_show_receipt), { onReceipt(taskId) }) }
        }
    }
}

/** One event: track icon in the track colour, a 12 dot on a 2 line in the track's subtle colour, the change and its time. */
@Composable
private fun Event(r: TransitionRecord, last: Boolean) {
    val track = MaterialTimeline.trackOf(r)
    val accent = trackAccent(track)
    val label = stringResource(R.string.a4_event, trackName(track), stateLabel(r.track.value, r.to))
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(track.icon, contentDescription = null, tint = accent, modifier = Modifier.size(VlSize.iconMd))
            Box(Modifier.size(12.dp).clip(CircleShape).background(accent))
            if (!last) Box(Modifier.width(2.dp).height(VlSpace.s7).background(trackSubtle(track)))
        }
        Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s1), modifier = Modifier.padding(bottom = VlSpace.s4)) {
            Text(label, style = Vl.text.bodySm, color = Vl.colors.textPrimary)
            if (track == Track.EDITORIAL && r.reason.isNotBlank()) Text(r.reason, style = Vl.text.captionMd, color = Vl.colors.textSecondary, maxLines = 3)
            Time(r)
        }
    }
}

@Composable
private fun Time(r: TransitionRecord) {
    val locale = LocalConfiguration.current.locales[0]
    val text = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(locale).format(r.occurredAt.atZoneSameInstant(ZoneId.systemDefault()))
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) { Text(text, style = Vl.text.monoMd, color = Vl.colors.textSecondary) }
}

@Composable
private fun trackName(t: Track): String = stringResource(
    when (t) { Track.TECHNICAL -> R.string.material_state_technical; Track.EDITORIAL -> R.string.material_state_editorial; Track.RIGHTS -> R.string.material_state_rights },
)
