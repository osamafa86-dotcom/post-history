package net.palpost.library.ui.uploads

import android.app.Activity
import android.app.Application
import android.app.RecoverableSecurityException
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.upload.UploadFailure
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.upload.UploadScheduler

class UploadsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    val tasks: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun resume() = viewModelScope.launch { UploadScheduler.resumePending(app) }

    fun retry(task: UploadTaskEntity) = viewModelScope.launch {
        container.database.uploads().requeueFailed(task.id, IdempotencyKey.generate())
        UploadScheduler.start(app, task.sizeBytes)
    }

    fun localCopyHandled(id: String) = viewModelScope.launch { container.database.uploads().setLocalCopyHandled(id, true) }
}

@Composable
fun UploadsScreen(container: AppContainer, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    val vm: UploadsViewModel = viewModel(factory = viewModelFactory { initializer { UploadsViewModel(app, container) } })
    val tasks by vm.tasks.collectAsStateWithLifecycle()

    // Deleting the local copy goes through the system's own confirmation (MediaStore delete request).
    var deleting by remember { mutableStateOf<UploadTaskEntity?>(null) }
    var deleteHint by remember { mutableStateOf<String?>(null) }
    val deleteLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val t = deleting ?: return@rememberLauncherForActivityResult
        if (result.resultCode == Activity.RESULT_OK) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) runCatching { context.contentResolver.delete(Uri.parse(t.fileUri), null, null) }
            vm.localCopyHandled(t.id)
        }
        deleting = null
    }
    val gallery = stringResource(R.string.uploads_delete_in_gallery)
    fun deleteLocal(t: UploadTaskEntity) {
        deleting = t
        val uri = Uri.parse(t.fileUri)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                deleteLauncher.launch(IntentSenderRequest.Builder(MediaStore.createDeleteRequest(context.contentResolver, listOf(uri)).intentSender).build())
            } else {
                context.contentResolver.delete(uri, null, null)
                vm.localCopyHandled(t.id); deleting = null
            }
        } catch (e: RecoverableSecurityException) {
            deleteLauncher.launch(IntentSenderRequest.Builder(e.userAction.actionIntent.intentSender).build())
        } catch (e: Exception) {
            // Not a MediaStore item (e.g. a document provider): the gallery or file manager has to do it.
            deleting = null; deleteHint = gallery
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.uploads_title)) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (tasks.isEmpty()) item { Text(stringResource(R.string.uploads_empty)) }
            else item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = vm::resume) { Text(stringResource(R.string.uploads_resume)) }
                    deleteHint?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
            }
            items(tasks, key = { it.id }) { t ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(t.title.ifBlank { t.filename }, style = MaterialTheme.typography.titleMedium)
                        Text(stateLabel(t), style = MaterialTheme.typography.bodyMedium)
                        val state = UploadState.valueOf(t.state)
                        if (!state.terminal) LinearProgressIndicator(progress = { if (t.sizeBytes > 0) (t.bytesConfirmed.toFloat() / t.sizeBytes).coerceIn(0f, 1f) else 0f }, modifier = Modifier.fillMaxWidth())
                        Text(stringResource(R.string.uploads_bytes, FieldInput.describeBytes(t.bytesConfirmed), FieldInput.describeBytes(t.sizeBytes)), style = MaterialTheme.typography.bodySmall)
                        t.receiptNumber?.let { Text(stringResource(R.string.uploads_receipt, it), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary) }
                        if (state == UploadState.FAILED) {
                            Text(failureLabel(t), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            OutlinedButton(onClick = { vm.retry(t) }) { Text(stringResource(R.string.uploads_retry)) }
                        }
                        if ((state == UploadState.VERIFIED || state == UploadState.DEDUPLICATED) && !t.localCopyHandled) {
                            // The prominent reminder (owner decision 2026-10-19): deletion is the reporter's choice, never automatic.
                            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), modifier = Modifier.fillMaxWidth()) {
                                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(stringResource(R.string.uploads_local_copy_title), style = MaterialTheme.typography.titleSmall)
                                    Text(stringResource(R.string.uploads_local_copy_body), style = MaterialTheme.typography.bodySmall)
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        Button(onClick = { deleteLocal(t) }) { Text(stringResource(R.string.uploads_delete_local)) }
                                        TextButton(onClick = { vm.localCopyHandled(t.id) }) { Text(stringResource(R.string.uploads_keep_local)) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun stateLabel(t: UploadTaskEntity): String = stringResource(
    when (UploadState.valueOf(t.state)) {
        UploadState.QUEUED -> R.string.upload_state_queued
        UploadState.HASHING -> R.string.upload_state_hashing
        UploadState.CREATING_SESSION -> R.string.upload_state_creating
        UploadState.UPLOADING -> R.string.upload_state_uploading
        UploadState.AWAITING_RECEIPT -> R.string.upload_state_awaiting_receipt
        UploadState.VERIFIED -> R.string.upload_state_verified
        UploadState.DEDUPLICATED -> R.string.upload_state_deduplicated
        UploadState.FAILED -> R.string.upload_state_failed
    },
)

@Composable
private fun failureLabel(t: UploadTaskEntity): String = stringResource(
    when (t.failure?.let { UploadFailure.valueOf(it) }) {
        UploadFailure.SESSION_EXPIRED -> R.string.upload_failure_session_expired
        UploadFailure.CHECKSUM_MISMATCH -> R.string.upload_failure_checksum
        UploadFailure.INVALID_FILE -> R.string.upload_failure_invalid_file
        UploadFailure.REJECTED -> R.string.upload_failure_rejected
        UploadFailure.FILE_UNAVAILABLE -> R.string.upload_failure_file_unavailable
        UploadFailure.STORAGE_ERROR -> R.string.upload_failure_storage
        UploadFailure.ABORTED -> R.string.upload_failure_aborted
        UploadFailure.DEVICE_NOT_TRUSTED -> R.string.upload_failure_device_not_trusted
        UploadFailure.UNKNOWN, null -> R.string.upload_failure_unknown
    },
)
