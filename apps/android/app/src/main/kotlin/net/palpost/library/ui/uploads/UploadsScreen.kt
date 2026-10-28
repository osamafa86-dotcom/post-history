package net.palpost.library.ui.uploads

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.upload.UploadFailure
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.DraftEntity
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.InlineAlert
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.PriorityBadge
import net.palpost.library.ui.theme.SecondaryButton
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.StateBadge
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.priorityTone
import net.palpost.library.ui.theme.rememberReduceMotion
import net.palpost.library.ui.theme.tokens.VlMotion
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.ui.material.priorityLabel
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.upload.UriGrants

/** A2 · the upload that resumes (docs/design/specs/reporter.md): where it is, that a cut is safe, and what comes next. */
class UploadsViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    private val meter = SpeedMeter()
    private var meterTask: String? = null
    private val previous = HashMap<String, String>()
    private val _receipts = MutableSharedFlow<String>(extraBufferCapacity = 1)
    /** A task that reached its receipt while this screen was open: A3 opens by itself (spec A2, VERIFIED). */
    val receipts: SharedFlow<String> = _receipts

    val tasks: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().onEach { list ->
        val now = System.currentTimeMillis()
        for (t in list) {
            val before = previous.put(t.id, t.state)
            if (before != null && before != t.state && t.state in DONE) _receipts.tryEmit(t.id)
        }
        activeOf(list)?.let { a ->
            if (meterTask != a.id) { meter.reset(); meterTask = a.id }
            meter.add(now, a.bytesConfirmed)
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val drafts: StateFlow<List<DraftEntity>> = container.database.drafts().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online
    private val _paused = MutableStateFlow(container.settings.uploadsPaused)
    val paused: StateFlow<Boolean> = _paused
    private val _wifiOnly = MutableStateFlow(container.settings.uploadOverWifiOnly)
    val wifiOnly: StateFlow<Boolean> = _wifiOnly

    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            _online.value = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
        override fun onLost(network: Network) { _online.value = false }
    }

    init {
        _online.value = connectivity?.activeNetwork?.let { connectivity.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) } == true
        runCatching { connectivity?.registerDefaultNetworkCallback(callback) }
    }

    override fun onCleared() { runCatching { connectivity?.unregisterNetworkCallback(callback) } }

    fun etaSeconds(t: UploadTaskEntity): Long? = if (meterTask == t.id) meter.etaSeconds(t.sizeBytes - t.bytesConfirmed) else null

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

    /** The confirmed "cancel" / "remove" of a queue row: drops an unfinished task or a finished one; the file on the phone is untouched. */
    fun remove(task: UploadTaskEntity) = viewModelScope.launch {
        container.database.uploads().delete(task.id)
        UriGrants.releaseIfUnused(app, container.database, task.fileUri) // the file is no longer needed by this app
    }

    companion object {
        val DONE = setOf(UploadState.VERIFIED.name, UploadState.DEDUPLICATED.name)
        /** The task in front of the queue: the oldest not yet finished (failed ones stay in front until retried or removed). */
        fun activeOf(list: List<UploadTaskEntity>): UploadTaskEntity? =
            list.filter { it.state !in DONE }.minByOrNull { it.createdAtEpochMs }
    }
}

@Composable
fun UploadsScreen(container: AppContainer, onBack: () -> Unit, onReceipt: (String) -> Unit, onNewMaterial: () -> Unit, onOpenDraft: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: UploadsViewModel = viewModel(factory = viewModelFactory { initializer { UploadsViewModel(app, container) } })
    val tasks by vm.tasks.collectAsStateWithLifecycle()
    val drafts by vm.drafts.collectAsStateWithLifecycle()
    val online by vm.online.collectAsStateWithLifecycle()
    val paused by vm.paused.collectAsStateWithLifecycle()
    val wifiOnly by vm.wifiOnly.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.receipts.collect { onReceipt(it) } }

    val active = UploadsViewModel.activeOf(tasks)
    val queue = tasks.filter { it.id != active?.id }
    // Cancelling or removing never happens on a gesture: a button asks here first, so a scroll can't lose an upload.
    var pendingRemoveId by rememberSaveable { mutableStateOf<String?>(null) }
    val pendingRemove = tasks.firstOrNull { it.id == pendingRemoveId }
    if (pendingRemove != null) RemoveDialog(
        done = pendingRemove.state in UploadsViewModel.DONE,
        onConfirm = { pendingRemoveId = null; vm.remove(pendingRemove) },
        onDismiss = { pendingRemoveId = null },
    )
    Scaffold(
        containerColor = Vl.colors.bgCanvas,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.uploads_title), style = Vl.text.headingH3) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = VlSpace.s5, vertical = VlSpace.s4),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s4),
        ) {
            if (drafts.isNotEmpty()) {
                items(drafts, key = { "d-" + it.id }) { d -> DraftRow(d) { onOpenDraft(d.id) } }
            }
            if (active == null && queue.isEmpty() && drafts.isEmpty()) item {
                VlCard {
                    Text(stringResource(R.string.uploads_empty), style = Vl.text.bodyMd, color = Vl.colors.textSecondary)
                    PrimaryButton(stringResource(R.string.home_new_material), onNewMaterial)
                }
            }
            if (active != null) item(key = "active-" + active.id) {
                ActiveCard(active, online, paused, wifiOnly, vm.etaSeconds(active), onPause = vm::togglePause, onWifi = vm::toggleWifiOnly, onRetry = { vm.retry(active) }, onRemove = { pendingRemoveId = active.id })
            }
            if (queue.isNotEmpty()) {
                item { SectionTitle(stringResource(R.string.a2_queue_title)) }
                items(queue, key = { it.id }) { t -> QueueRow(t, onOpen = { if (t.state in UploadsViewModel.DONE) onReceipt(t.id) }, onRemove = { pendingRemoveId = t.id }) }
            }
        }
    }
}

/** Asks before an upload is cancelled (unfinished) or its row removed (finished). Destructive confirm; dismiss keeps everything. */
@Composable
private fun RemoveDialog(done: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (done) R.string.a2_remove_title else R.string.a2_cancel_title), style = Vl.text.headingH4) },
        text = { Text(stringResource(if (done) R.string.a2_remove_body else R.string.a2_cancel_body), style = Vl.text.bodySm) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.heightIn(min = MinTouchTarget), colors = ButtonDefaults.textButtonColors(contentColor = Vl.colors.textDanger)) {
                Text(stringResource(if (done) R.string.a2_remove_confirm else R.string.a2_cancel_confirm), style = Vl.text.labelLg)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = MinTouchTarget)) { Text(stringResource(if (done) R.string.a2_remove_keep else R.string.a2_cancel_keep), style = Vl.text.labelLg) } },
    )
}

@Composable
private fun DraftRow(d: DraftEntity, onOpen: () -> Unit) {
    VlCard(modifier = Modifier.clickable(onClick = onOpen), gap = VlSpace.s3) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            StateBadge(null, stringResource(R.string.a2_draft_badge), Tone.NEUTRAL)
            Text(d.title.ifBlank { stringResource(R.string.a2_draft_untitled) }, style = Vl.text.labelMd, color = Vl.colors.textPrimary, maxLines = 1)
        }
    }
}

@Composable
private fun ActiveCard(
    t: UploadTaskEntity, online: Boolean, paused: Boolean, wifiOnly: Boolean, etaSeconds: Long?,
    onPause: () -> Unit, onWifi: () -> Unit, onRetry: () -> Unit, onRemove: () -> Unit,
) {
    val state = UploadState.valueOf(t.state)
    val waiting = !online || paused
    val border = if (state == UploadState.FAILED) Vl.colors.toneBadBorder else if (waiting) Vl.colors.toneNeutralBorder else Vl.colors.toneProgressBorder
    VlCard(border = border) {
        // 1. Header: title, priority, file name and size.
        Text(t.title.ifBlank { t.filename }, style = Vl.text.headingH4, color = Vl.colors.textPrimary, maxLines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            t.priority?.let { p -> net.palpost.library.api.models.Priority.entries.firstOrNull { it.value == p }?.let { PriorityBadge(priorityLabel(it), priorityTone(it)) } }
            Text(t.filename + " · " + FieldInput.describeBytes(t.sizeBytes), style = Vl.text.captionMd, color = Vl.colors.textSecondary, maxLines = 1)
        }
        when (state) {
            UploadState.QUEUED, UploadState.HASHING, UploadState.CREATING_SESSION -> Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(VlSpace.s6), strokeWidth = VlSpace.s1, color = Vl.colors.bgBrand)
                Text(stringResource(if (waiting) waitingText(paused) else R.string.a2_preparing), style = Vl.text.labelLg, color = Vl.colors.textPrimary)
            }
            UploadState.UPLOADING, UploadState.AWAITING_RECEIPT -> Progress(t, state, online, paused, etaSeconds)
            UploadState.FAILED -> InlineAlert(Tone.BAD, failureLabel(t), Icons.Outlined.ErrorOutline) {
                SecondaryButton(stringResource(R.string.uploads_retry), onRetry)
                GhostButton(stringResource(R.string.a2_remove), onRemove, modifier = Modifier.heightIn(min = MinTouchTarget))
            }
            UploadState.VERIFIED, UploadState.DEDUPLICATED -> Unit
        }
        // 5. The reassurance never hides.
        Row(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(VlRadius.md)).background(Vl.colors.bgBrandSubtle).padding(VlSpace.s4),
            horizontalArrangement = Arrangement.spacedBy(VlSpace.s3),
        ) {
            Icon(Icons.Outlined.Shield, contentDescription = null, tint = Vl.colors.iconBrand)
            Text(stringResource(R.string.a2_safe_cut), style = Vl.text.bodySm, color = Vl.colors.textPrimary)
        }
        // 6. Pause / resume and Wi-Fi only.
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            SecondaryButton(stringResource(if (paused) R.string.a2_resume else R.string.a2_pause), onPause, leading = if (paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause)
            GhostButton(stringResource(if (wifiOnly) R.string.a2_wifi_only_on else R.string.a2_wifi_only_off), onWifi)
        }
    }
}

private fun waitingText(paused: Boolean) = if (paused) R.string.a2_paused else R.string.a2_waiting_network

@Composable
private fun Progress(t: UploadTaskEntity, state: UploadState, online: Boolean, paused: Boolean, etaSeconds: Long?) {
    val reduceMotion = rememberReduceMotion()
    val fraction = if (state == UploadState.AWAITING_RECEIPT) 1f else if (t.sizeBytes > 0) (t.bytesConfirmed.toFloat() / t.sizeBytes).coerceIn(0f, 1f) else 0f
    val shown by animateFloatAsState(fraction, if (reduceMotion) tween(0) else tween(VlMotion.progressMs, easing = VlMotion.linear), label = "progress")
    val percent = (fraction * 100).toInt()
    val waiting = !online || paused
    // 3. The percentage, always left-to-right, then what is uploading and the bytes / time left.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Text("$percent%", style = Vl.text.displayMd, color = if (waiting) Vl.colors.textSecondary else Vl.colors.textBrand)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
        if (waiting) Icon(if (paused) Icons.Outlined.Pause else Icons.Outlined.CloudOff, contentDescription = null, tint = Vl.colors.iconMuted)
        Text(
            stringResource(when { waiting -> waitingText(paused); state == UploadState.AWAITING_RECEIPT -> R.string.a2_awaiting_digest; else -> R.string.a2_original_uploading }),
            style = Vl.text.labelLg, color = Vl.colors.textPrimary,
        )
    }
    val bytes = stringResource(R.string.uploads_bytes, FieldInput.describeBytes(t.bytesConfirmed), FieldInput.describeBytes(t.sizeBytes))
    val eta = etaSeconds?.takeIf { !waiting && state == UploadState.UPLOADING }?.let { stringResource(R.string.a2_eta, formatDuration(it)) }
    Text(listOfNotNull(bytes, eta).joinToString(" · "), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
    // 4. The bar (10 tall) and the part row (bars 24×6, as the spec draws them).
    Box(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(VlRadius.full)).background(Vl.colors.bgSubtle)) {
        Box(Modifier.fillMaxWidth(shown).height(10.dp).clip(RoundedCornerShape(VlRadius.full)).background(if (waiting) Vl.colors.toneNeutralBorder else Vl.colors.bgBrand))
    }
    val parts = UploadParts.of(t.sizeBytes, t.bytesConfirmed, t.partSizeBytes, active = state == UploadState.UPLOADING && !waiting)
    if (parts.total > 0) {
        val caption = stringResource(R.string.a2_parts, parts.confirmed, parts.total) + (parts.current?.let { " · " + stringResource(R.string.a2_part_current, it) } ?: "")
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = caption }) {
            for (b in parts.bars) {
                val c = when (b) { PartState.CONFIRMED -> Vl.colors.bgBrand; PartState.CURRENT -> Vl.colors.toneProgressBorder; PartState.LATER -> Vl.colors.borderDefault }
                Box(Modifier.width(24.dp).height(6.dp).clip(RoundedCornerShape(VlRadius.full)).background(c))
            }
        }
        Text(caption, style = Vl.text.captionMd, color = Vl.colors.textSecondary)
    }
}

@Composable
private fun formatDuration(seconds: Long): String = when {
    seconds < 60 -> stringResource(R.string.a2_eta_seconds, seconds)
    seconds < 3600 -> stringResource(R.string.a2_eta_minutes, (seconds + 59) / 60)
    else -> stringResource(R.string.a2_eta_hours, seconds / 3600, (seconds % 3600) / 60)
}

@Composable
private fun QueueRow(t: UploadTaskEntity, onOpen: () -> Unit, onRemove: () -> Unit) {
    val done = t.state in UploadsViewModel.DONE
    VlCard(modifier = Modifier.heightIn(min = VlSize.touchMin), gap = VlSpace.s2) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).clickable(enabled = done, onClick = onOpen), verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                Text(t.title.ifBlank { t.filename }, style = Vl.text.labelMd, color = Vl.colors.textPrimary, maxLines = 2)
                // Several files belong to one material and share its title: the file name tells the rows apart.
                if (t.title.isNotBlank()) Text(t.filename, style = Vl.text.captionMd, color = Vl.colors.textSecondary, maxLines = 1)
                val receipt = t.receiptNumber
                if (receipt != null) {
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Text(receipt, style = Vl.text.monoMd, color = Vl.colors.textBrand)
                    }
                    if (!t.localCopyHandled) Text(stringResource(R.string.a2_local_copy_pending), style = Vl.text.captionMd, color = Vl.colors.toneAttentionFg)
                } else Text(stateLabel(t), style = Vl.text.captionMd, color = if (t.state == UploadState.FAILED.name) Vl.colors.textDanger else Vl.colors.textSecondary)
            }
            // An explicit button, never a swipe: it only opens the confirmation.
            val named = stringResource(if (done) R.string.a2_remove_named else R.string.a2_cancel_named, t.filename)
            TextButton(
                onClick = onRemove, modifier = Modifier.heightIn(min = MinTouchTarget).widthIn(min = MinTouchTarget).semantics { contentDescription = named },
                colors = ButtonDefaults.textButtonColors(contentColor = Vl.colors.textDanger),
            ) { Text(stringResource(if (done) R.string.a2_remove else R.string.a2_cancel), style = Vl.text.labelMd) }
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
