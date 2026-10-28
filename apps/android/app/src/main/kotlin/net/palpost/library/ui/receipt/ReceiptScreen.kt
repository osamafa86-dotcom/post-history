package net.palpost.library.ui.receipt

import android.app.Activity
import android.app.Application
import android.app.RecoverableSecurityException
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
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
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
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.Overline
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.SecondaryButton
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.rememberReduceMotion
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlMotion
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.upload.UriGrants
import java.io.File
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** A3 · the receipt: an event, not a line. Number, digest, the supervisor's acknowledgement, and the local copy. */
class ReceiptViewModel(private val app: Application, private val container: AppContainer, taskId: String) : ViewModel() {
    val task: StateFlow<UploadTaskEntity?> = container.database.uploads().observe(taskId).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    private val _ack = MutableStateFlow<OffsetDateTime?>(null)
    val ack: StateFlow<OffsetDateTime?> = _ack

    /** Re-reads the transitions while the screen is open, so the supervisor's acknowledgement appears when it lands. */
    fun watchAcknowledgement(materialId: String) = viewModelScope.launch {
        while (isActive && _ack.value == null) {
            runCatching { container.materialsApi.listTransitions(java.util.UUID.fromString(materialId)).items }
                .onSuccess { _ack.value = ReceiptModel.acknowledgedAt(it) }
            delay(30_000)
        }
    }

    fun localCopyHandled(id: String) = viewModelScope.launch {
        val uri = container.database.uploads().get(id)?.fileUri
        container.database.uploads().setLocalCopyHandled(id, true)
        // The reporter has decided about the local copy (deleted it or kept it): the app no longer needs its read grant.
        if (uri != null) UriGrants.releaseIfUnused(app, container.database, uri, exceptTaskId = id)
    }
}

@Composable
fun ReceiptScreen(container: AppContainer, taskId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    val vm: ReceiptViewModel = viewModel(key = "receipt-$taskId", factory = viewModelFactory { initializer { ReceiptViewModel(app, container, taskId) } })
    val t by vm.task.collectAsStateWithLifecycle()
    val ack by vm.ack.collectAsStateWithLifecycle()
    val task = t
    LaunchedEffect(task?.materialId) { task?.materialId?.let { vm.watchAcknowledgement(it) } }

    Scaffold(
        containerColor = Vl.colors.bgCanvas,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.a3_title), style = Vl.text.headingH3) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) },
    ) { padding ->
        if (task == null) return@Scaffold
        val dedup = task.state == UploadState.DEDUPLICATED.name
        val scope = rememberCoroutineScope()
        var copied by remember { mutableStateOf(false) }
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = VlSpace.s5, vertical = VlSpace.s5),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s5),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Hero(dedup)
            ReceiptCard(task, ack)
            val share = ReceiptModel.shareContent(task.receiptNumber, task.updatedAtEpochMs)
            if (share != null) {
                val palette = SharePalette(
                    background = Vl.colors.bgCanvas.toArgb(), card = Vl.colors.bgSurfaceRaised.toArgb(), border = Vl.colors.borderStrong.toArgb(),
                    primary = Vl.colors.textPrimary.toArgb(), secondary = Vl.colors.textSecondary.toArgb(), brand = Vl.colors.textBrand.toArgb(),
                )
                val labels = ShareLabels(stringResource(R.string.a3_receipt_label), stringResource(R.string.a3_row_received), formatDateTime(share.receivedAtEpochMs), stringResource(R.string.a3_share))
                SecondaryButton(stringResource(R.string.a3_share), onClick = { scope.launch { shareReceipt(context, share, labels, palette) } }, modifier = Modifier.fillMaxWidth(), leading = Icons.Outlined.Share)
            }
            val clipLabel = stringResource(R.string.a3_receipt_label)
            GhostButton(stringResource(if (copied) R.string.a3_copied else R.string.a3_copy_number), onClick = {
                task.receiptNumber?.let { n ->
                    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(clipLabel, n))
                    copied = true
                }
            })
            if (!task.localCopyHandled) LocalCopyCard(task, onHandled = { vm.localCopyHandled(task.id) })
        }
    }
}

@Composable
private fun Hero(dedup: Boolean) {
    val reduceMotion = rememberReduceMotion()
    val view = LocalView.current
    val anim = remember { Animatable(if (reduceMotion || dedup) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!dedup) view.performHapticFeedback(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        if (!reduceMotion) anim.animateTo(1f, tween(VlMotion.slowMs, easing = VlMotion.emphasized))
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s4), modifier = Modifier.scale(0.9f + 0.1f * anim.value).alpha(anim.value)) {
        val bg = if (dedup) Vl.colors.toneNeutralBg else Vl.colors.toneGoodBg
        val border = if (dedup) Vl.colors.toneNeutralBorder else Vl.colors.toneGoodBorder
        val fg = if (dedup) Vl.colors.toneNeutralFg else Vl.colors.toneGoodFg
        Box(Modifier.size(88.dp).clip(CircleShape).background(bg).border(VlBorder.regular, border, CircleShape), contentAlignment = Alignment.Center) {
            Icon(if (dedup) Icons.Outlined.Receipt else Icons.Outlined.Check, contentDescription = null, tint = fg, modifier = Modifier.size(40.dp))
        }
        Text(stringResource(if (dedup) R.string.a3_hero_dedup else R.string.a3_hero), style = Vl.text.headingH2, color = Vl.colors.textPrimary, modifier = Modifier.semantics { heading() })
        Text(stringResource(if (dedup) R.string.a3_hero_dedup_body else R.string.a3_hero_body), style = Vl.text.bodyMd, color = Vl.colors.textSecondary)
    }
}

@Composable
private fun ReceiptCard(t: UploadTaskEntity, ack: OffsetDateTime?) {
    val language = LocalConfiguration.current.locales[0]?.language ?: "ar"
    VlCard(border = Vl.colors.borderStrong, background = Vl.colors.bgSurfaceRaised, gap = VlSpace.s4) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Receipt, contentDescription = null, tint = Vl.colors.iconBrand)
            Overline(stringResource(R.string.a3_receipt_label))
        }
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            SelectionContainer { Text(t.receiptNumber.orEmpty(), style = Vl.text.monoLg, color = Vl.colors.textPrimary) }
        }
        Detail(stringResource(R.string.a3_row_material), t.title.ifBlank { stringResource(R.string.a3_untitled) })
        Detail(stringResource(R.string.a3_row_received), formatDateTime(t.updatedAtEpochMs))
        Detail(stringResource(R.string.a3_row_size), FieldInput.describeBytes(t.sizeBytes))
        ReceiptModel.shortDigest(t.sha256)?.let { Detail("SHA-256", it, mono = true) }
        Detail(stringResource(R.string.a3_row_supervisor), ack?.let { stringResource(R.string.a3_seen_at, formatTime(it)) } ?: stringResource(R.string.a3_not_seen))
        ReceiptModel.materialLink(BuildConfig.WEB_BASE_URL, language, t.materialId)?.let { link ->
            val qr = remember(link) { qrBitmap(link, 288) }
            Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), verticalAlignment = Alignment.CenterVertically) {
                Image(qr, contentDescription = stringResource(R.string.a3_qr_label), modifier = Modifier.size(96.dp).clip(RoundedCornerShape(VlRadius.sm)))
                Text(stringResource(R.string.a3_qr_caption), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
            }
        }
    }
}

@Composable
private fun Detail(label: String, value: String, mono: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), modifier = Modifier.fillMaxWidth()) {
        Text(label, style = Vl.text.labelMd, color = Vl.colors.textSecondary, modifier = Modifier.weight(0.4f))
        if (mono) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Text(value, style = Vl.text.monoMd, color = Vl.colors.textPrimary, modifier = Modifier.weight(0.6f))
        } else Text(value, style = Vl.text.bodySm, color = Vl.colors.textPrimary, modifier = Modifier.weight(0.6f))
    }
}

/** The local-copy decision (owner decision 2026-10-19): attention, not danger; deletion recommended, never automatic. */
@Composable
private fun LocalCopyCard(t: UploadTaskEntity, onHandled: () -> Unit) {
    val context = LocalContext.current
    var hint by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) runCatching { context.contentResolver.delete(Uri.parse(t.fileUri), null, null) }
            onHandled()
        }
    }
    val gallery = stringResource(R.string.uploads_delete_in_gallery)
    fun delete() {
        val uri = Uri.parse(t.fileUri)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                launcher.launch(IntentSenderRequest.Builder(MediaStore.createDeleteRequest(context.contentResolver, listOf(uri)).intentSender).build())
            } else {
                context.contentResolver.delete(uri, null, null); onHandled()
            }
        } catch (e: RecoverableSecurityException) {
            launcher.launch(IntentSenderRequest.Builder(e.userAction.actionIntent.intentSender).build())
        } catch (e: Exception) {
            // Not a MediaStore item (a document provider): the gallery or file manager has to do it.
            hint = gallery
        }
    }
    VlCard(background = Vl.colors.toneAttentionBg, border = Vl.colors.toneAttentionBorder, gap = VlSpace.s3) {
        Text(stringResource(R.string.uploads_local_copy_title), style = Vl.text.labelLg, color = Vl.colors.textPrimary)
        Text(stringResource(R.string.uploads_local_copy_body), style = Vl.text.bodySm, color = Vl.colors.textPrimary)
        hint?.let { Text(it, style = Vl.text.bodySm, color = Vl.colors.textDanger) }
        PrimaryButton(stringResource(R.string.uploads_delete_local), ::delete, leading = Icons.Outlined.Lock)
        GhostButton(stringResource(R.string.uploads_keep_local), onHandled)
    }
}

@Composable
private fun formatDateTime(epochMs: Long): String {
    val locale = LocalConfiguration.current.locales[0]
    return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))
}

@Composable
private fun formatTime(t: OffsetDateTime): String {
    val locale = LocalConfiguration.current.locales[0]
    return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(t.atZoneSameInstant(ZoneId.systemDefault()))
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
        val text = runCatching { androidx.core.content.res.ResourcesCompat.getFont(context, R.font.vazirmatn_500) }.getOrNull()
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
