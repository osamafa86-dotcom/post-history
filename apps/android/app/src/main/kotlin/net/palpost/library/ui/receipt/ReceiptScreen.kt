package net.palpost.library.ui.receipt

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.BuildConfig
import net.palpost.library.R
import net.palpost.library.core.send.LocalCopyPolicy
import net.palpost.library.core.send.UploadOverview
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.theme.BroadcastRings
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.SolidButton
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.upload.UriGrants
import java.io.File
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * 06 · the celebratory receipt (reporter-v2.md «الإيصال»): full rings, «Delivered», the receipt number, time, size and fingerprint
 * (left to right), the choice to delete the local copies (off by default, applied the moment it is ticked), and two actions.
 * A send of several files has one receipt when its last file arrives (ADR 0088); a material outside any send (a replacement
 * shot, or an earlier build's) has its own, with the QR, the share image and the supervisor's acknowledgement as before.
 * No source name and no location anywhere on it.
 */
class ReceiptViewModel(private val app: Application, private val container: AppContainer, private val target: ReceiptTarget) : ViewModel() {
    val rows: StateFlow<List<UploadTaskEntity>> = container.database.uploads().observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private val _ack = MutableStateFlow<OffsetDateTime?>(null)
    val ack: StateFlow<OffsetDateTime?> = _ack
    val batch = (target as? ReceiptTarget.Batch)?.let { t -> container.sendBatches.batches.firstOrNull { it.id == t.batchId } }

    /** The receipt's rows: the send's arrived originals, or the one row. */
    fun scope(all: List<UploadTaskEntity>): List<UploadTaskEntity> = when (target) {
        is ReceiptTarget.Task -> all.filter { it.id == target.taskId }
        is ReceiptTarget.Batch -> batch?.let { b -> itemsOf(b, all).filter { it.state == net.palpost.library.core.send.UploadItem.State.ARRIVED }.mapNotNull { i -> all.firstOrNull { it.id == i.id } } }.orEmpty()
    }

    /** Re-reads the transitions while a single material's receipt is open, so the supervisor's acknowledgement appears when it lands. */
    fun watchAcknowledgement(materialId: String) = viewModelScope.launch {
        while (isActive && _ack.value == null) {
            runCatching { container.materialsApi.listTransitions(java.util.UUID.fromString(materialId)).items }
                .onSuccess { _ack.value = ReceiptModel.acknowledgedAt(it) }
            delay(30_000)
        }
    }

    /** The reporter deleted the local copies (or decided otherwise): the rows remember it and the read grants go. */
    fun handled(ids: List<String>) = viewModelScope.launch {
        for (id in ids) {
            val uri = container.database.uploads().get(id)?.fileUri
            container.database.uploads().setLocalCopyHandled(id, true)
            if (uri != null) UriGrants.releaseIfUnused(app, container.database, uri, exceptTaskId = id)
        }
    }
}

@Composable
fun ReceiptScreen(container: AppContainer, target: ReceiptTarget, onDone: () -> Unit, onSendAnother: () -> Unit, onMyMaterials: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    val key = when (target) { is ReceiptTarget.Batch -> "receipt-b-${target.batchId}"; is ReceiptTarget.Task -> "receipt-t-${target.taskId}" }
    val vm: ReceiptViewModel = viewModel(key = key, factory = viewModelFactory { initializer { ReceiptViewModel(app, container, target) } })
    val all by vm.rows.collectAsStateWithLifecycle()
    val ack by vm.ack.collectAsStateWithLifecycle()
    val scope = vm.scope(all)
    val single = (target as? ReceiptTarget.Task)?.let { t -> scope.firstOrNull { it.id == t.taskId } }
    LaunchedEffect(single?.materialId) { single?.materialId?.let { vm.watchAcknowledgement(it) } }
    val view = LocalView.current
    LaunchedEffect(Unit) {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
    }
    val deduplicated = single?.state == UploadState.DEDUPLICATED.name
    val count = scope.size.coerceAtLeast(1)
    val title = vm.batch?.title ?: single?.title.orEmpty()
    val numbers = scope.mapNotNull { it.receiptNumber?.takeIf(String::isNotBlank) }
    val choice = LocalCopyPolicy.receiptChoice(scope, state = { UploadState.valueOf(it.state) }, hasLocalCopy = { !it.localCopyHandled })
    var deleted by rememberSaveable { mutableStateOf(false) }
    val doneLabel = stringResource(R.string.receipt_done_a11y)

    Column(
        Modifier.fillMaxSize().background(Vl.colors.bgBase).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(VlSpace.s5),
        verticalArrangement = Arrangement.spacedBy(VlSpace.s5), horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { VlIconButton(Icons.Outlined.Close, stringResource(R.string.receipt_close), onDone) }
        BroadcastRings(UploadOverview.RingState.DONE, 1f, VlSpace.s12 * 2 + VlSpace.s5, a11y = doneLabel)
        Text(
            stringResource(if (deduplicated) R.string.a3_hero_dedup else if (count > 1) R.string.receipt_title else R.string.receipt_title_one),
            style = Vl.text.display, color = Vl.colors.textPrimary, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() },
        )
        Text(
            when {
                deduplicated -> stringResource(R.string.a3_hero_dedup_body)
                count > 1 -> stringResource(R.string.receipt_body, pluralStringResource(R.plurals.receipt_items, count, count), title)
                else -> stringResource(R.string.receipt_body_one, title)
            },
            style = Vl.text.body, color = Vl.colors.textSecondary, textAlign = TextAlign.Center,
        )
        if (choice.deletable.isNotEmpty() || deleted) DeleteLocal(choice.deletable, deleted, onDeleted = { ids -> deleted = true; vm.handled(ids) })
        else if (choice.awaitingVerification.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Schedule, contentDescription = null, tint = Vl.colors.textSecondary, modifier = Modifier.size(VlIcon.md))
            Text(stringResource(R.string.receipt_delete_after_verification), style = Vl.text.caption, color = Vl.colors.textSecondary)
        }
        if (!deduplicated) Slip(scope, numbers)
        if (single != null && !deduplicated) SingleExtras(context, single, ack)
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.fillMaxWidth()) {
            OutlineButton(stringResource(R.string.receipt_again), onSendAnother, modifier = Modifier.weight(1f))
            SolidButton(stringResource(R.string.home_materials), onMyMaterials, modifier = Modifier.weight(1f))
        }
    }
}

/** The receipt card: number (the first; «Show all N» opens the rest), time, size and fingerprint, all left to right. */
@Composable
private fun Slip(scope: List<UploadTaskEntity>, numbers: List<String>) {
    var showAll by rememberSaveable { mutableStateOf(false) }
    VlCard(border = Vl.colors.borderEdge, gap = VlSpace.s3) {
        numbers.firstOrNull()?.let { SlipRow(stringResource(R.string.a3_receipt_label), it, mono = true) }
        scope.maxOfOrNull { it.updatedAtEpochMs }?.let { HorizontalDivider(color = Vl.colors.borderLine); SlipRow(stringResource(R.string.receipt_row_time), formatTime(it)) }
        HorizontalDivider(color = Vl.colors.borderLine)
        SlipRow(stringResource(R.string.a3_row_size), FieldInput.describeBytes(scope.sumOf { it.sizeBytes.coerceAtLeast(0) }))
        if (scope.size == 1) ReceiptModel.fingerprint(scope.first().sha256)?.let { HorizontalDivider(color = Vl.colors.borderLine); SlipRow(stringResource(R.string.receipt_row_fingerprint), it, mono = true) }
    }
    if (numbers.size > 1) {
        GhostButton(if (showAll) stringResource(R.string.receipt_numbers_hide) else stringResource(R.string.receipt_numbers_show, numbers.size), { showAll = !showAll })
        if (showAll) VlCard(gap = VlSpace.s2) { for (n in numbers) SlipRow(stringResource(R.string.a3_receipt_label), n, mono = true) }
    }
}

@Composable
private fun SlipRow(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s4)) {
        Text(label, style = Vl.text.label, color = Vl.colors.textSecondary, modifier = Modifier.weight(1f))
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            SelectionContainer { Text(value, style = if (mono) Vl.text.receipt else Vl.text.num, color = Vl.colors.textPrimary) }
        }
    }
}

/**
 * «Delete the local copies from the phone»: off by default, applied the moment it is ticked (locking the phone or closing the
 * app with the receipt open keeps nothing), never unticked after. Only originals the server verified or matched are offered
 * (`LocalCopyPolicy`). On Android the copy is the picked file in the gallery, deleted through the system's own confirmation.
 */
@Composable
private fun DeleteLocal(rows: List<UploadTaskEntity>, deleted: Boolean, onDeleted: (List<String>) -> Unit) {
    val context = LocalContext.current
    var hint by remember { mutableStateOf<String?>(null) }
    val ids = rows.map { it.id }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) onDeleted(ids)
    }
    val gallery = stringResource(R.string.uploads_delete_in_gallery)
    fun delete() {
        val uris = rows.map { Uri.parse(it.fileUri) }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                launcher.launch(IntentSenderRequest.Builder(MediaStore.createDeleteRequest(context.contentResolver, uris).intentSender).build())
            } else {
                for (u in uris) context.contentResolver.delete(u, null, null)
                onDeleted(ids)
            }
        } catch (e: android.app.RecoverableSecurityException) {
            launcher.launch(IntentSenderRequest.Builder(e.userAction.actionIntent.intentSender).build())
        } catch (e: Exception) {
            // Not a MediaStore item (a document provider): the gallery or file manager has to do it.
            hint = gallery
        }
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).clip(RoundedCornerShape(VlRadius.md)).clickable(enabled = !deleted) { delete() }
            .semantics(mergeDescendants = true) { role = Role.Checkbox },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3),
    ) {
        Checkbox(
            checked = deleted, onCheckedChange = { if (it && !deleted) delete() }, enabled = !deleted,
            colors = CheckboxDefaults.colors(checkedColor = Vl.colors.actionPrimary, checkmarkColor = Vl.colors.textOnBrand, disabledCheckedColor = Vl.colors.actionPrimary),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
            Text(stringResource(R.string.receipt_delete_local), style = Vl.text.headline, color = Vl.colors.textPrimary)
            Text(stringResource(if (deleted) R.string.receipt_delete_local_done else R.string.receipt_delete_local_hint), style = Vl.text.caption, color = Vl.colors.textSecondary)
            hint?.let { Text(it, style = Vl.text.caption, color = Vl.colors.stateDanger) }
        }
    }
}

/** A single material's receipt keeps what it had: the supervisor's acknowledgement, the QR, the share image and copying the number. */
@Composable
private fun SingleExtras(context: Context, t: UploadTaskEntity, ack: OffsetDateTime?) {
    val language = LocalConfiguration.current.locales[0]?.language ?: "ar"
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    VlCard(gap = VlSpace.s3) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VlSpace.s4)) {
            Text(stringResource(R.string.a3_row_supervisor), style = Vl.text.label, color = Vl.colors.textSecondary, modifier = Modifier.weight(1f))
            Text(ack?.let { stringResource(R.string.a3_seen_at, formatOffsetTime(it)) } ?: stringResource(R.string.a3_not_seen), style = Vl.text.label, color = if (ack != null) Vl.colors.stateOk else Vl.colors.textSecondary)
        }
        ReceiptModel.materialLink(BuildConfig.WEB_BASE_URL, language, t.materialId)?.let { link ->
            val qr = remember(link) { qrBitmap(link, 288) }
            Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), verticalAlignment = Alignment.CenterVertically) {
                Image(qr, contentDescription = stringResource(R.string.a3_qr_label), modifier = Modifier.size(VlSpace.s12 + VlSpace.s5).clip(RoundedCornerShape(VlRadius.sm)))
                Text(stringResource(R.string.a3_qr_caption), style = Vl.text.caption, color = Vl.colors.textSecondary)
            }
        }
    }
    val share = ReceiptModel.shareContent(t.receiptNumber, t.updatedAtEpochMs)
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
        if (share != null) {
            val palette = SharePalette(
                background = Vl.colors.bgBase.toArgb(), card = Vl.colors.bgRaised.toArgb(), border = Vl.colors.borderEdge.toArgb(),
                primary = Vl.colors.textPrimary.toArgb(), secondary = Vl.colors.textSecondary.toArgb(), brand = Vl.colors.textBrand.toArgb(),
            )
            val labels = ShareLabels(stringResource(R.string.a3_receipt_label), stringResource(R.string.a3_row_received), formatDateTime(share.receivedAtEpochMs), stringResource(R.string.a3_share))
            GhostButton(stringResource(R.string.a3_share), { scope.launch { shareReceipt(context, share, labels, palette) } }, leading = Icons.Outlined.Share)
        }
        val clipLabel = stringResource(R.string.a3_receipt_label)
        GhostButton(stringResource(if (copied) R.string.a3_copied else R.string.a3_copy_number), {
            t.receiptNumber?.let { n ->
                context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(clipLabel, n))
                copied = true
            }
        }, leading = Icons.Outlined.ContentCopy)
    }
}

@Composable
private fun formatTime(epochMs: Long): String {
    val locale = LocalConfiguration.current.locales[0]
    return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))
}

@Composable
private fun formatOffsetTime(t: OffsetDateTime): String {
    val locale = LocalConfiguration.current.locales[0]
    return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(t.atZoneSameInstant(ZoneId.systemDefault()))
}


@Composable
private fun formatDateTime(epochMs: Long): String {
    val locale = LocalConfiguration.current.locales[0]
    return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))
}

/** A QR code with a quiet zone, dark on white for any scanner. */
private fun qrBitmap(content: String, sizePx: Int): ImageBitmap {
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, mapOf(EncodeHintType.MARGIN to 1))
    val pixels = IntArray(sizePx * sizePx) { i -> if (matrix.get(i % sizePx, i / sizePx)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(pixels, sizePx, sizePx, Bitmap.Config.ARGB_8888).asImageBitmap()
}

private data class SharePalette(val background: Int, val card: Int, val border: Int, val primary: Int, val secondary: Int, val brand: Int)
private data class ShareLabels(val receipt: String, val received: String, val time: String, val chooser: String)

/**
 * Shares a 1080×1350 PNG of the receipt through the system sheet. The image is drawn here from [ReceiptModel.ShareContent]
 * alone (number and time), not captured from the screen, so nothing else on the card can slip into it. The file
 * lives in the cache (`receipts/`, the only path the FileProvider exposes) and is replaced on every share.
 */
private suspend fun shareReceipt(context: Context, content: ReceiptModel.ShareContent, labels: ShareLabels, palette: SharePalette) {
    val uri = withContext(Dispatchers.IO) {
        val w = 1080; val h = 1350
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(out)
        canvas.drawColor(palette.background)
        val text = runCatching { androidx.core.content.res.ResourcesCompat.getFont(context, R.font.readex_pro_500) }.getOrNull()
        val mono = runCatching { androidx.core.content.res.ResourcesCompat.getFont(context, R.font.ibm_plex_mono_500) }.getOrNull()
        val card = android.graphics.RectF(80f, 380f, w - 80f, 970f)
        val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = palette.card }
        val stroke = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = palette.border; style = android.graphics.Paint.Style.STROKE; strokeWidth = 4f }
        canvas.drawRoundRect(card, 36f, 36f, fill)
        canvas.drawRoundRect(card, 36f, 36f, stroke)
        fun line(s: String, size: Float, color: Int, face: android.graphics.Typeface?, y: Float) {
            val p = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = size; this.color = color; typeface = face }
            val layout = android.text.StaticLayout.Builder.obtain(s, 0, s.length, p, (card.width() - 120f).toInt())
                .setAlignment(android.text.Layout.Alignment.ALIGN_CENTER).build()
            canvas.save(); canvas.translate(card.left + 60f, y); layout.draw(canvas); canvas.restore()
        }
        line(labels.receipt, 44f, palette.secondary, text, card.top + 90f)
        line("\u2066" + content.receiptNumber + "\u2069", 76f, palette.brand, mono, card.top + 210f)
        line(labels.received, 40f, palette.secondary, text, card.top + 360f)
        line("\u2066" + labels.time + "\u2069", 48f, palette.primary, mono, card.top + 430f)
        val dir = File(context.cacheDir, "receipts").apply { mkdirs() }
        val file = File(dir, "receipt.png")
        file.outputStream().use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }
        FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
    }
    val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, labels.chooser))
}
