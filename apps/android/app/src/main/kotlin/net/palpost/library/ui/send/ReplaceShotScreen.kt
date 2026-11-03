package net.palpost.library.ui.send

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.upload.UploadTask
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.material.PickedOriginal
import net.palpost.library.ui.theme.EmptyState
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.upload.UriGrants
import java.util.UUID

/**
 * «Upload a replacement shot» for an existing material (asked for changes, or the technical track failed): one file, no new
 * material, as before (ADR 0082 §6); its receipt is the material's own, outside any send.
 */
class ReplaceShotViewModel(private val app: Application, private val container: AppContainer, private val materialId: String) : ViewModel() {
    data class UiState(val title: String = "", val file: PickedOriginal? = null, val sending: Boolean = false, val error: String? = null, val queuedTaskId: String? = null)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    init {
        viewModelScope.launch {
            runCatching { container.materialsApi.getMaterial(UUID.fromString(materialId)) }.onSuccess { m -> _state.update { it.copy(title = m.title) } }
        }
    }

    fun pick(uri: Uri) = viewModelScope.launch {
        val old = _state.value.file?.uri
        val f = withContext(Dispatchers.IO) {
            try { app.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (e: SecurityException) { /* not persistable */ }
            var name = "original"
            var size = 0L
            app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { i -> if (!c.isNull(i)) size = c.getLong(i) }
                }
            }
            PickedOriginal(uri.toString(), name, size, app.contentResolver.getType(uri))
        }
        _state.update { it.copy(file = f, error = null) }
        if (old != null && old != f.uri) UriGrants.releaseIfUnused(app, container.database, old)
    }

    fun discard() = viewModelScope.launch { _state.value.file?.let { UriGrants.releaseIfUnused(app, container.database, it.uri) } }

    fun send() {
        val s = _state.value
        val f = s.file ?: return
        if (s.sending) return
        _state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            try {
                val task = UploadTask(
                    id = UUID.randomUUID().toString(), materialId = materialId, kind = "original", fileUri = f.uri, filename = f.name,
                    mimeType = f.mimeType, sizeBytes = f.sizeBytes, idempotencyKey = IdempotencyKey.generate(), createdAtEpochMs = System.currentTimeMillis(),
                    ownerAccount = container.scope.value.current, // ADR 0093
                )
                container.uploadStore.insert(task, title = s.title, priority = null)
                UploadScheduler.start(app, f.sizeBytes)
                _state.update { it.copy(sending = false, queuedTaskId = task.id) }
            } catch (t: Throwable) {
                _state.update { it.copy(sending = false, error = describeFailure(app, t)) }
            }
        }
    }
}

@Composable
fun ReplaceShotScreen(container: AppContainer, materialId: String, onClose: () -> Unit, onQueued: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: ReplaceShotViewModel = viewModel(key = "replace-$materialId", factory = viewModelFactory { initializer { ReplaceShotViewModel(app, container, materialId) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(s.queuedTaskId) { if (s.queuedTaskId != null) onQueued() }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) vm.pick(uri) }
    val pick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }
    val close = { vm.discard(); onClose() }
    BackHandler(enabled = !s.sending) { close() }
    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.a1_title_replacement), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.Outlined.Close, stringResource(R.string.send_close), close, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(VlSpace.s5), verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
            if (s.title.isNotBlank()) Text(stringResource(R.string.a1_replacement_for, s.title), style = Vl.text.body, color = Vl.colors.textSecondary)
            val f = s.file
            if (f == null) {
                EmptyState(Icons.Outlined.PhotoLibrary, stringResource(R.string.a1_title_replacement), stringResource(R.string.a1_file_help)) {
                    OutlineButton(stringResource(R.string.a1_pick_gallery), pick, small = true)
                }
            } else {
                VlCard {
                    Text(FieldInput.describeBytes(f.sizeBytes), style = Vl.text.num, color = Vl.colors.textPrimary)
                    Text(stringResource(R.string.a1_original_as_is), style = Vl.text.caption, color = Vl.colors.textSecondary)
                    OutlineButton(stringResource(R.string.a1_change_file), pick, small = true)
                }
                s.error?.let { Text(it, style = Vl.text.caption, color = Vl.colors.stateDanger) }
                PrimaryButton(stringResource(if (s.sending) R.string.send_sending else R.string.replace_send), vm::send, enabled = !s.sending)
            }
        }
    }
}
