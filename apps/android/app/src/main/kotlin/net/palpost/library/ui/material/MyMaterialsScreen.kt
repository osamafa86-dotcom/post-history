package net.palpost.library.ui.material

import android.app.Application
import android.text.format.DateUtils
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.RightsState
import net.palpost.library.api.models.TechnicalState
import net.palpost.library.ui.describeFailure

/**
 * «Materials»: the reporter's own materials (the server scopes `GET /materials` to them) with the three states
 * kept apart, technical, editorial and rights, as the plan requires; one is never folded into another.
 */
class MyMaterialsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    data class UiState(
        val items: List<Material> = emptyList(),
        val nextCursor: String? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val selected: Material? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    fun refresh() = load(cursor = null)

    fun more() { _state.value.nextCursor?.let { load(it) } }

    private fun load(cursor: String?) {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val page = container.materialsApi.listMaterials(cursor = cursor, limit = PAGE)
                _state.update { s -> s.copy(items = if (cursor == null) page.items else s.items + page.items, nextCursor = page.nextCursor, loading = false) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = describeFailure(app, e)) }
            }
        }
    }

    /** Opens a material, then reads it again so its states are the server's current ones. */
    fun open(m: Material) {
        _state.update { it.copy(selected = m) }
        viewModelScope.launch {
            runCatching { container.materialsApi.getMaterial(m.id) }.onSuccess { fresh -> _state.update { if (it.selected?.id == fresh.id) it.copy(selected = fresh) else it } }
        }
    }

    fun close() = _state.update { it.copy(selected = null) }

    private companion object { const val PAGE = 30L }
}

@Composable
fun MyMaterialsScreen(container: AppContainer, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: MyMaterialsViewModel = viewModel(factory = viewModelFactory { initializer { MyMaterialsViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (s.items.isEmpty()) vm.refresh() }

    val selected = s.selected
    val back = if (selected != null) vm::close else onBack
    androidx.activity.compose.BackHandler(enabled = selected != null) { vm.close() }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(selected?.title ?: stringResource(R.string.materials_title)) },
            navigationIcon = { TextButton(onClick = back) { Text(stringResource(R.string.action_back)) } },
            actions = { if (selected == null) TextButton(onClick = vm::refresh, enabled = !s.loading) { Text(stringResource(R.string.materials_refresh)) } },
        )
    }) { padding ->
        if (selected != null) MaterialDetail(selected, Modifier.padding(padding))
        else LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            s.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (s.items.isEmpty() && !s.loading && s.error == null) item { Text(stringResource(R.string.materials_empty)) }
            items(s.items, key = { it.id }) { m ->
                Card(modifier = Modifier.fillMaxWidth().clickable { vm.open(m) }) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(m.title, style = MaterialTheme.typography.titleMedium)
                        Text(relative(m.createdAt.toInstant().toEpochMilli()), style = MaterialTheme.typography.bodySmall)
                        StateLine(R.string.material_state_technical, technical(m.technicalState))
                        StateLine(R.string.material_state_editorial, editorial(m.editorialState))
                        StateLine(R.string.material_state_rights, rights(m.rightsState))
                    }
                }
            }
            if (s.loading) item { Text(stringResource(R.string.materials_loading)) }
            else if (s.nextCursor != null) item { OutlinedButton(onClick = vm::more, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.materials_more)) } }
        }
    }
}

@Composable
private fun MaterialDetail(m: Material, modifier: Modifier) {
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            StateLine(R.string.material_state_technical, technical(m.technicalState))
            StateLine(R.string.material_state_editorial, editorial(m.editorialState))
            StateLine(R.string.material_state_rights, rights(m.rightsState))
            Text(stringResource(R.string.material_states_independent), style = MaterialTheme.typography.bodySmall)
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text(stringResource(R.string.material_files), style = MaterialTheme.typography.titleSmall)
            if (m.files.isEmpty()) Text(stringResource(R.string.material_no_files))
        }
        items(m.files, key = { it.id }) { f ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(fileKind(f.kind)) + " · " + stringResource(fileState(f.state)), style = MaterialTheme.typography.bodyMedium)
                f.receiptNumber?.let { Text(stringResource(R.string.material_receipt, it), style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@Composable
internal fun StateLine(@StringRes label: Int, @StringRes value: Int) =
    Text(stringResource(label) + ": " + stringResource(value), style = MaterialTheme.typography.bodyMedium)

internal fun relative(epochMs: Long): String = DateUtils.getRelativeTimeSpanString(epochMs, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

@StringRes internal fun technical(s: TechnicalState) = when (s) {
    TechnicalState.pending -> R.string.technical_pending
    TechnicalState.proxy_received -> R.string.technical_proxy_received
    TechnicalState.original_received -> R.string.technical_original_received
    TechnicalState.verified -> R.string.technical_verified
    TechnicalState.failed -> R.string.technical_failed
}

@StringRes internal fun editorial(s: EditorialState) = when (s) {
    EditorialState.inbox -> R.string.editorial_inbox
    EditorialState.acknowledged -> R.string.editorial_acknowledged
    EditorialState.reviewing -> R.string.editorial_reviewing
    EditorialState.needs_changes -> R.string.editorial_needs_changes
    EditorialState.accepted -> R.string.editorial_accepted
    EditorialState.in_production -> R.string.editorial_in_production
    EditorialState.final_review -> R.string.editorial_final_review
    EditorialState.published -> R.string.editorial_published
    EditorialState.rejected -> R.string.editorial_rejected
}

@StringRes internal fun rights(s: RightsState) = when (s) {
    RightsState.unknown -> R.string.rights_unknown
    RightsState.documented -> R.string.rights_documented
    RightsState.sellable -> R.string.rights_sellable
    RightsState.blocked -> R.string.rights_blocked
    RightsState.withdrawn -> R.string.rights_withdrawn
}

@StringRes internal fun fileKind(k: MaterialFile.Kind) = when (k) {
    MaterialFile.Kind.original -> R.string.file_kind_original
    MaterialFile.Kind.proxy -> R.string.file_kind_proxy
    MaterialFile.Kind.hls -> R.string.file_kind_hls
    MaterialFile.Kind.audio -> R.string.file_kind_audio
    MaterialFile.Kind.thumbnail -> R.string.file_kind_thumbnail
    MaterialFile.Kind.voice_note -> R.string.file_kind_voice_note
    MaterialFile.Kind.transcript -> R.string.file_kind_transcript
    MaterialFile.Kind.captions -> R.string.file_kind_captions
}

@StringRes internal fun fileState(s: MaterialFile.State) = when (s) {
    MaterialFile.State.uploading -> R.string.file_state_uploading
    MaterialFile.State.received -> R.string.file_state_received
    MaterialFile.State.verified -> R.string.file_state_verified
    MaterialFile.State.failed -> R.string.file_state_failed
}
