package net.palpost.library.ui.review

import android.app.Application
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.RightsState
import net.palpost.library.api.models.TechnicalState
import net.palpost.library.api.models.Transition
import net.palpost.library.api.models.TransitionRecord
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.material.StateLine
import net.palpost.library.ui.material.editorial
import net.palpost.library.ui.material.fileKind
import net.palpost.library.ui.material.fileState
import net.palpost.library.ui.material.relative
import net.palpost.library.ui.material.rights
import net.palpost.library.ui.material.technical

/**
 * The supervisor's short review screen: the inbox of their scope (the server scopes `GET /materials`) by editorial
 * state, a material with its three states apart and its transition history, and the editorial decisions of
 * [ReviewPolicy]. Shown: title, governorate, priority, time, states and files. Never shown: coordinates, the
 * reporter's identity or legal name, or dynamic fields (which may hold protected sources).
 */
class ReviewViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    /** A decision being written; its idempotency key is kept so a retry after a network failure is the same request. */
    data class Pending(val action: ReviewAction, val reason: String = "", val key: String = IdempotencyKey.generate())

    data class UiState(
        val filter: EditorialState = ReviewPolicy.QUEUE.first(),
        val items: List<Material> = emptyList(),
        val nextCursor: String? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val selected: Material? = null,
        val history: List<TransitionRecord> = emptyList(),
        val pending: Pending? = null,
        val submitting: Boolean = false,
        @StringRes val notice: Int? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun select(filter: EditorialState) {
        _state.update { it.copy(filter = filter, items = emptyList(), nextCursor = null) }
        load(null)
    }

    fun refresh() = load(null)

    fun more() { _state.value.nextCursor?.let { load(it) } }

    private fun load(cursor: String?) {
        if (_state.value.loading) return
        val filter = _state.value.filter
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val page = container.materialsApi.listMaterials(editorialState = filter, cursor = cursor, limit = PAGE)
                _state.update { s ->
                    if (s.filter != filter) s.copy(loading = false)
                    else s.copy(items = ReviewPolicy.ordered(if (cursor == null) page.items else s.items + page.items), nextCursor = page.nextCursor, loading = false)
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = describeFailure(app, e)) }
            }
        }
    }

    fun open(m: Material) {
        _state.update { it.copy(selected = m, history = emptyList(), pending = null, notice = null) }
        reload(m.id)
    }

    /** Reads the material and its history again, so decisions are offered on the server's current state. */
    private fun reload(id: java.util.UUID) {
        viewModelScope.launch {
            runCatching { container.materialsApi.getMaterial(id) }.onSuccess { fresh -> _state.update { if (it.selected?.id == id) it.copy(selected = fresh) else it } }
            runCatching { container.materialsApi.listTransitions(id).items }.onSuccess { h -> _state.update { if (it.selected?.id == id) it.copy(history = h) else it } }
        }
    }

    fun close() {
        _state.update { it.copy(selected = null, pending = null, notice = null) }
        refresh()
    }

    fun begin(action: ReviewAction) = _state.update { it.copy(pending = Pending(action), notice = null) }

    fun reason(text: String) = _state.update { s -> s.copy(pending = s.pending?.copy(reason = text)) }

    fun cancel() = _state.update { it.copy(pending = null) }

    fun submit() {
        val s = _state.value
        val m = s.selected ?: return
        val p = s.pending ?: return
        val reason = ReviewPolicy.reason(p.reason) ?: return
        if (s.submitting) return
        _state.update { it.copy(submitting = true, notice = null) }
        viewModelScope.launch {
            val result = runCatching {
                container.materialsApi.transitionMaterial(
                    idempotencyKey = p.key,
                    id = m.id,
                    transition = Transition(track = Transition.Track.editorial, to = p.action.to.value, reason = reason),
                    ifMatch = ReviewPolicy.ifMatch(m),
                )
            }
            when (ReviewPolicy.outcomeOf(result.exceptionOrNull())) {
                ReviewPolicy.Outcome.DONE -> {
                    _state.update { it.copy(submitting = false, pending = null, selected = result.getOrNull() ?: it.selected, notice = R.string.review_done) }
                    reload(m.id)
                }
                ReviewPolicy.Outcome.STALE -> {
                    _state.update { it.copy(submitting = false, pending = null, notice = R.string.review_stale) }
                    reload(m.id)
                }
                ReviewPolicy.Outcome.FORBIDDEN -> _state.update { it.copy(submitting = false, pending = null, notice = R.string.review_forbidden) }
                ReviewPolicy.Outcome.RETRY -> _state.update { it.copy(submitting = false, notice = R.string.review_retry) }
                ReviewPolicy.Outcome.FAILED -> _state.update { it.copy(submitting = false, pending = null, notice = R.string.review_failed) }
            }
        }
    }

    private companion object { const val PAGE = 30L }
}

@Composable
fun ReviewScreen(container: AppContainer, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: ReviewViewModel = viewModel(factory = viewModelFactory { initializer { ReviewViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (s.items.isEmpty()) vm.refresh() }

    val selected = s.selected
    androidx.activity.compose.BackHandler(enabled = selected != null) { vm.close() }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(selected?.title ?: stringResource(R.string.review_title)) },
            navigationIcon = { TextButton(onClick = if (selected != null) vm::close else onBack) { Text(stringResource(R.string.action_back)) } },
            actions = { if (selected == null) TextButton(onClick = vm::refresh, enabled = !s.loading) { Text(stringResource(R.string.materials_refresh)) } },
        )
    }) { padding ->
        if (selected != null) ReviewDetail(s, selected, vm, Modifier.padding(padding))
        else LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ReviewPolicy.QUEUE.forEach { st ->
                        FilterChip(selected = s.filter == st, onClick = { vm.select(st) }, label = { Text(stringResource(editorial(st))) })
                    }
                }
            }
            s.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (s.items.isEmpty() && !s.loading && s.error == null) item { Text(stringResource(R.string.review_empty)) }
            items(s.items, key = { it.id }) { m ->
                Card(modifier = Modifier.fillMaxWidth().clickable { vm.open(m) }) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(m.title, style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(priority(m.priority)) + " · " + m.governorate + " · " + relative(m.createdAt.toInstant().toEpochMilli()), style = MaterialTheme.typography.bodySmall)
                        StateLine(R.string.material_state_technical, technical(m.technicalState))
                        StateLine(R.string.material_state_rights, rights(m.rightsState))
                    }
                }
            }
            if (s.loading) item { Text(stringResource(R.string.materials_loading)) }
            else if (s.nextCursor != null) item { OutlinedButton(onClick = vm::more, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.materials_more)) } }
        }
    }

    s.pending?.let { p ->
        AlertDialog(
            onDismissRequest = { if (!s.submitting) vm.cancel() },
            title = { Text(stringResource(actionLabel(p.action))) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.review_reason_hint))
                    OutlinedTextField(value = p.reason, onValueChange = { if (it.length <= ReviewPolicy.REASON_MAX) vm.reason(it) }, label = { Text(stringResource(R.string.review_reason)) }, minLines = 2)
                    s.notice?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = { Button(onClick = vm::submit, enabled = !s.submitting && ReviewPolicy.reason(p.reason) != null) { Text(stringResource(R.string.review_confirm)) } },
            dismissButton = { TextButton(onClick = vm::cancel, enabled = !s.submitting) { Text(stringResource(R.string.review_cancel)) } },
        )
    }
}

@Composable
private fun ReviewDetail(s: ReviewViewModel.UiState, m: Material, vm: ReviewViewModel, modifier: Modifier) {
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text(stringResource(priority(m.priority)) + " · " + m.governorate, style = MaterialTheme.typography.bodyMedium)
            StateLine(R.string.material_state_technical, technical(m.technicalState))
            StateLine(R.string.material_state_editorial, editorial(m.editorialState))
            StateLine(R.string.material_state_rights, rights(m.rightsState))
            Text(stringResource(R.string.material_states_independent), style = MaterialTheme.typography.bodySmall)
            if (s.pending == null) s.notice?.let { Text(stringResource(it), style = MaterialTheme.typography.bodyMedium) }
        }
        val actions = ReviewPolicy.actionsFor(m.editorialState)
        if (actions.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEach { a ->
                    if (a == ReviewAction.REJECT) OutlinedButton(onClick = { vm.begin(a) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(actionLabel(a)), color = MaterialTheme.colorScheme.error) }
                    else Button(onClick = { vm.begin(a) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(actionLabel(a))) }
                }
            }
        }
        item {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text(stringResource(R.string.material_files), style = MaterialTheme.typography.titleSmall)
            if (m.files.isEmpty()) Text(stringResource(R.string.material_no_files))
        }
        items(m.files, key = { it.id }) { f ->
            Text(stringResource(fileKind(f.kind)) + " · " + stringResource(fileState(f.state)), style = MaterialTheme.typography.bodyMedium)
        }
        item {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text(stringResource(R.string.review_history), style = MaterialTheme.typography.titleSmall)
            if (s.history.isEmpty()) Text(stringResource(R.string.review_history_empty))
        }
        items(s.history, key = { it.id }) { r ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.review_history_line, stringResource(trackLabel(r.track)), stateText(r.track, r.from), stateText(r.track, r.to)), style = MaterialTheme.typography.bodyMedium)
                Text(relative(r.occurredAt.toInstant().toEpochMilli()) + " · " + r.reason, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun stateText(track: TransitionRecord.Track, value: String): String = when (track) {
    TransitionRecord.Track.editorial -> EditorialState.entries.firstOrNull { it.value == value }?.let { stringResource(editorial(it)) }
    TransitionRecord.Track.technical -> TechnicalState.entries.firstOrNull { it.value == value }?.let { stringResource(technical(it)) }
    TransitionRecord.Track.rights -> RightsState.entries.firstOrNull { it.value == value }?.let { stringResource(rights(it)) }
} ?: value

@StringRes private fun trackLabel(t: TransitionRecord.Track) = when (t) {
    TransitionRecord.Track.editorial -> R.string.material_state_editorial
    TransitionRecord.Track.technical -> R.string.material_state_technical
    TransitionRecord.Track.rights -> R.string.material_state_rights
}

@StringRes private fun actionLabel(a: ReviewAction) = when (a) {
    ReviewAction.ACKNOWLEDGE -> R.string.review_acknowledge
    ReviewAction.START_REVIEW -> R.string.review_start
    ReviewAction.REQUEST_CHANGES -> R.string.review_request_changes
    ReviewAction.ACCEPT -> R.string.review_accept
    ReviewAction.REJECT -> R.string.review_reject
}

@StringRes private fun priority(p: Priority) = when (p.value) {
    "urgent" -> R.string.priority_urgent
    "important" -> R.string.priority_important
    else -> R.string.priority_normal
}
