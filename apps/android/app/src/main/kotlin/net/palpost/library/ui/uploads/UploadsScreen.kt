package net.palpost.library.ui.uploads

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Size
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.send.SendBatch
import net.palpost.library.core.send.UploadItem
import net.palpost.library.core.send.UploadOverview
import net.palpost.library.core.upload.UploadFailure
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.theme.BroadcastRings
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.upload.UriGrants
import kotlin.math.roundToInt

/** 05 · the upload with the broadcast rings: the last send and every file not finished or failed, one row each; a cut is safe. */
class UploadsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    val tasks: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online
    private val _paused = MutableStateFlow(container.settings.uploadsPaused)
    val paused: StateFlow<Boolean> = _paused
    private val _wifiOnly = MutableStateFlow(container.settings.uploadOverWifiOnly)
    val wifiOnly: StateFlow<Boolean> = _wifiOnly

    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            _online.value = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
                (!container.settings.uploadOverWifiOnly || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
        }
        override fun onLost(network: Network) { _online.value = false }
    }

    init {
        _online.value = connectivity?.activeNetwork?.let { connectivity.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) } == true
        runCatching { connectivity?.registerDefaultNetworkCallback(callback) }
    }

    override fun onCleared() { runCatching { connectivity?.unregisterNetworkCallback(callback) } }

    /** The newest send, from the ledger (read each time the rows change). */
    fun lastBatch(): SendBatch? = container.sendBatches.batches.firstOrNull()

    fun togglePause() = viewModelScope.launch {
        val now = !container.settings.uploadsPaused
        container.settings.uploadsPaused = now
        _paused.value = now
        if (!now) UploadScheduler.resumePending(app)
    }

    fun toggleWifiOnly() = viewModelScope.launch {
        val now = !container.settings.uploadOverWifiOnly
        container.settings.uploadOverWifiOnly = now
        _wifiOnly.value = now
        UploadScheduler.resumePending(app) // re-arms the transfer with the new network constraint
    }

    fun retry(task: UploadTaskEntity) = viewModelScope.launch {
        container.database.uploads().requeueFailed(task.id, IdempotencyKey.generate())
        UploadScheduler.start(app, task.sizeBytes)
    }

    /** The confirmed «cancel» / «remove» of a row: drops an unfinished task or a finished one; the file on the phone is untouched. */
    fun remove(task: UploadTaskEntity) = viewModelScope.launch {
        container.database.uploads().delete(task.id)
        UriGrants.releaseIfUnused(app, container.database, task.fileUri) // the file is no longer needed by this app
    }

    companion object {
        val DONE = setOf(UploadState.VERIFIED.name, UploadState.DEDUPLICATED.name)

        /** The rows the screen shows: unfinished and failed first (oldest first, as the queue runs), then the last send's arrived ones. */
        fun rowsInScope(rows: List<UploadTaskEntity>, last: SendBatch?): List<UploadTaskEntity> {
            val open = rows.filter { it.state !in DONE }.sortedBy { it.createdAtEpochMs }
            val arrived = rows.filter { it.state in DONE && last != null && it.materialId in last.materialIds }.sortedBy { it.createdAtEpochMs }
            return open + arrived
        }

        fun itemOf(r: UploadTaskEntity, paused: Boolean) =
            UploadItem(r.id, r.materialId, r.sizeBytes, r.bytesConfirmed, UploadItem.stateOf(UploadState.valueOf(r.state)), paused = paused)
    }
}

@Composable
fun UploadsScreen(container: AppContainer, onBack: () -> Unit, onReceipt: (String) -> Unit, onPickFileFor: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: UploadsViewModel = viewModel(factory = viewModelFactory { initializer { UploadsViewModel(app, container) } })
    val tasks by vm.tasks.collectAsStateWithLifecycle()
    val online by vm.online.collectAsStateWithLifecycle()
    val paused by vm.paused.collectAsStateWithLifecycle()
    val wifiOnly by vm.wifiOnly.collectAsStateWithLifecycle()
    val last = vm.lastBatch()
    val rows = UploadsViewModel.rowsInScope(tasks, last)
    val items = rows.map { UploadsViewModel.itemOf(it, paused) }
    val ring = UploadOverview.ringState(items, online && !paused)
    val fraction = UploadOverview.fraction(items).toFloat()
    // Cancelling or removing never happens on a gesture: a button asks here first, so a scroll can't lose an upload.
    var pendingRemoveId by rememberSaveable { mutableStateOf<String?>(null) }
    val pendingRemove = tasks.firstOrNull { it.id == pendingRemoveId }
    if (pendingRemove != null) RemoveDialog(
        done = pendingRemove.state in UploadsViewModel.DONE,
        onConfirm = { pendingRemoveId = null; vm.remove(pendingRemove) },
        onDismiss = { pendingRemoveId = null },
    )
    val ringWord = stringResource(
        when (ring) {
            UploadOverview.RingState.UPLOADING -> R.string.upload_ring_uploading
            UploadOverview.RingState.WAITING -> if (paused) R.string.a2_paused else if (items.isEmpty()) R.string.upload_ring_idle else R.string.upload_ring_waiting
            UploadOverview.RingState.DONE -> R.string.upload_ring_done
            UploadOverview.RingState.FAILED -> R.string.upload_ring_failed
        },
    )
    val percent = "${(fraction * 100).roundToInt()}%"
    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.uploads_title), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.action_back), onBack, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = VlSpace.s5, vertical = VlSpace.s4),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s4),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                BroadcastRings(ring, fraction, VlSpace.s12 * 3, a11y = "$percent · $ringWord", percent = if (ring == UploadOverview.RingState.DONE) null else percent, caption = ringWord)
            }
            item {
                val line = when {
                    items.isEmpty() -> R.string.uploads_empty
                    !online && !paused && items.any { it.isActive } -> R.string.upload_offline
                    ring == UploadOverview.RingState.FAILED -> R.string.upload_failed_line
                    ring == UploadOverview.RingState.DONE -> R.string.upload_done_line
                    else -> R.string.a2_safe_cut
                }
                VlCard(background = Vl.colors.bgSunken, padding = VlSpace.s4) { Text(stringResource(line), style = Vl.text.body, color = Vl.colors.textPrimary) }
            }
            items(rows, key = { it.id }) { t ->
                UploadRow(
                    t, concealed = last == null || t.materialId !in last.materialIds || last.sensitive != false, online = online, paused = paused,
                    onOpen = { if (t.state in UploadsViewModel.DONE) onReceipt(t.id) }, onRetry = { vm.retry(t) }, onPickFile = { onPickFileFor(t.materialId) },
                    onRemove = { pendingRemoveId = t.id },
                )
            }
            if (rows.any { it.state !in UploadsViewModel.DONE }) item {
                Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                    OutlineButton(stringResource(if (paused) R.string.a2_resume else R.string.a2_pause), vm::togglePause, leading = if (paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause, small = true)
                    GhostButton(stringResource(if (wifiOnly) R.string.a2_wifi_only_on else R.string.a2_wifi_only_off), vm::toggleWifiOnly)
                }
            }
            item { Text(stringResource(R.string.upload_background), style = Vl.text.caption, color = Vl.colors.textSecondary, textAlign = TextAlign.Center) }
        }
    }
}

/**
 * `Upload row`: the file (thumbnail, or its kind's icon while its material's sensitivity is unknown or «yes»), the title with its
 * `(i/N)`, and the stage as a word, an icon and a colour; the percentage and a bar while transferring. Cancel and remove are a
 * button with a confirmation, never a swipe. A final failure says why and offers two steps.
 */
@Composable
private fun UploadRow(
    t: UploadTaskEntity, concealed: Boolean, online: Boolean, paused: Boolean,
    onOpen: () -> Unit, onRetry: () -> Unit, onPickFile: () -> Unit, onRemove: () -> Unit,
) {
    val state = UploadState.valueOf(t.state)
    val done = t.state in UploadsViewModel.DONE
    val c = Vl.colors
    VlCard(gap = VlSpace.s3, padding = VlSpace.s4, modifier = Modifier.semantics(mergeDescendants = false) {}) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            Thumb(t, concealed)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
                Text(t.title.ifBlank { stringResource(R.string.a3_untitled) }, style = Vl.text.headline, color = c.textPrimary, maxLines = 2)
                Text(FieldInput.describeBytes(t.sizeBytes), style = Vl.text.num, color = c.textSecondary)
            }
            val (icon, word, color) = when {
                done -> Triple(Icons.Outlined.Check, stringResource(R.string.upload_stage_original), c.stateOk)
                state == UploadState.FAILED -> Triple(Icons.Outlined.ErrorOutline, stringResource(R.string.upload_state_failed), c.stateDanger)
                paused -> Triple(Icons.Outlined.Pause, stringResource(R.string.a2_paused), c.stateWarn)
                !online -> Triple(Icons.Outlined.CloudOff, stringResource(R.string.a2_waiting_network), c.stateWarn)
                state == UploadState.UPLOADING -> Triple(null, "${(t.progressFraction() * 100).roundToInt()}%", c.textBrand)
                state == UploadState.AWAITING_RECEIPT -> Triple(Icons.Outlined.Schedule, stringResource(R.string.a2_awaiting_digest), c.stateMuted)
                else -> Triple(Icons.Outlined.Schedule, stringResource(R.string.a2_preparing), c.stateMuted)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(VlIcon.sm))
                CompositionLocalProvider(LocalLayoutDirection provides if (icon == null) LayoutDirection.Ltr else LocalLayoutDirection.current) {
                    Text(word, style = Vl.text.label, color = color)
                }
            }
        }
        if (state == UploadState.UPLOADING && !done) {
            Box(Modifier.fillMaxWidth().height(VlBorder.progress).clip(RoundedCornerShape(VlRadius.full)).background(c.borderLine)) {
                Box(Modifier.fillMaxWidth(t.progressFraction()).height(VlBorder.progress).clip(RoundedCornerShape(VlRadius.full)).background(if (online && !paused) c.actionPrimary else c.stateMuted))
            }
        }
        if (state == UploadState.FAILED) Text(failureLabel(t), style = Vl.text.body, color = c.textPrimary)
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            if (state == UploadState.FAILED) {
                if (t.failure == UploadFailure.FILE_UNAVAILABLE.name) OutlineButton(stringResource(R.string.upload_pick_file), onPickFile, small = true)
                else OutlineButton(stringResource(R.string.uploads_retry), onRetry, small = true)
            }
            if (done) GhostButton(stringResource(R.string.upload_show_receipt), onOpen)
            val named = stringResource(if (done) R.string.a2_remove_named_title else R.string.a2_cancel_named_title, t.title)
            GhostButton(
                stringResource(if (done || state == UploadState.FAILED) R.string.a2_remove else R.string.a2_cancel), onRemove, destructive = true,
                modifier = Modifier.semantics { contentDescription = named },
            )
        }
    }
}

private fun UploadTaskEntity.progressFraction(): Float = if (sizeBytes > 0) (bytesConfirmed.toFloat() / sizeBytes).coerceIn(0f, 1f) else 0f

/** The row's picture: the system's thumbnail of the picked file, never a copy; an icon while the material may be sensitive. */
@Composable
private fun Thumb(t: UploadTaskEntity, concealed: Boolean) {
    val context = LocalContext.current
    val video = t.mimeType?.startsWith("video/") == true
    val bitmap by produceState<ImageBitmap?>(null, t.fileUri, concealed) {
        value = if (concealed) null else withContext(Dispatchers.IO) {
            runCatching { context.contentResolver.loadThumbnail(Uri.parse(t.fileUri), Size(144, 144), null).asImageBitmap() }.getOrNull()
        }
    }
    val shape = RoundedCornerShape(VlRadius.sm)
    Box(Modifier.size(MinTouchTarget).clip(shape).background(Vl.colors.bgSunken), contentAlignment = Alignment.Center) {
        val b = bitmap
        if (b != null) Image(b, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
        else Icon(if (video) Icons.Outlined.Movie else Icons.Outlined.Image, contentDescription = null, tint = Vl.colors.textSecondary, modifier = Modifier.size(VlIcon.md))
    }
}

/** Asks before an upload is cancelled (unfinished) or its row removed (finished); dismissing keeps everything. */
@Composable
private fun RemoveDialog(done: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (done) R.string.a2_remove_title else R.string.a2_cancel_title), style = Vl.text.headline) },
        text = { Text(stringResource(if (done) R.string.a2_remove_body else R.string.a2_cancel_body), style = Vl.text.body) },
        confirmButton = { GhostButton(stringResource(if (done) R.string.a2_remove_confirm else R.string.a2_cancel_confirm), onConfirm, destructive = true) },
        dismissButton = { GhostButton(stringResource(if (done) R.string.a2_remove_keep else R.string.a2_cancel_keep), onDismiss) },
    )
}

@Composable
internal fun failureLabel(t: UploadTaskEntity): String = stringResource(
    when (t.failure?.let { runCatching { UploadFailure.valueOf(it) }.getOrNull() }) {
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

/** The row's state in a word, for lists elsewhere (home's recent sends). */
@Composable
fun stageWord(t: UploadTaskEntity): String = stringResource(
    when (UploadState.valueOf(t.state)) {
        UploadState.QUEUED, UploadState.HASHING, UploadState.CREATING_SESSION -> R.string.a2_preparing
        UploadState.UPLOADING -> R.string.upload_state_uploading
        UploadState.AWAITING_RECEIPT -> R.string.a2_awaiting_digest
        UploadState.VERIFIED, UploadState.DEDUPLICATED -> R.string.upload_stage_original
        UploadState.FAILED -> R.string.upload_state_failed
    },
)
