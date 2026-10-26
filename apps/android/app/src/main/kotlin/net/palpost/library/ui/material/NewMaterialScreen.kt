package net.palpost.library.ui.material

import android.app.Application
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.draw.drawBehind
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
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.infrastructure.Serializer
import net.palpost.library.api.models.DisplayName
import net.palpost.library.api.models.MaterialCreate
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.Sensitivity
import net.palpost.library.api.models.UploadForm
import net.palpost.library.api.models.UploadFormField
import net.palpost.library.core.forms.FormValidator
import net.palpost.library.core.forms.ValidationResult
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.upload.UploadTask
import net.palpost.library.data.DraftEntity
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.forms.DynamicForm
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.forms.PickedFile
import net.palpost.library.ui.forms.materialTypeLabel
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.InlineAlert
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.SecondaryButton
import net.palpost.library.ui.theme.SectionTitle
import net.palpost.library.ui.theme.StateBadge
import net.palpost.library.ui.theme.Stepper
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlCard
import net.palpost.library.ui.theme.priorityTone
import net.palpost.library.ui.theme.toneColors
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace
import net.palpost.library.upload.UploadScheduler
import java.io.File
import java.util.UUID

/** The file the reporter picked for the original: kept as a persistable content URI, never copied. */
data class PickedOriginal(val uri: Uri, val name: String, val sizeBytes: Long, val mimeType: String?)

data class NewMaterialUiState(
    val step: Int = 1,
    val title: String = "",
    val types: Set<MaterialType> = emptySet(),
    val governorate: String = "",
    val city: String = "",
    val priority: Priority = Priority.normal,
    val minors: Boolean? = null,
    val injured: Boolean? = null,
    val graphic: Boolean? = null,
    val displayMode: DisplayName.Mode = DisplayName.Mode.network,
    val pseudonym: String = "",
    val form: UploadForm? = null,
    /** The form shown is the last one saved on the phone, because the current one could not be fetched. */
    val formCached: Boolean = false,
    val formError: String? = null,
    val values: Map<String, Any?> = emptyMap(),
    val picked: Map<String, List<PickedFile>> = emptyMap(),
    val original: PickedOriginal? = null,
    val thumbnail: ImageBitmap? = null,
    val durationMs: Long? = null,
    val showErrors: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val createdTaskId: String? = null,
    /** "Upload a replacement shot" (A4): the file goes to this existing material; steps 2 and 3 do not apply. */
    val attachTo: String? = null,
    val attachTitle: String = "",
    val draftSaved: Boolean = false,
) {
    val primaryType: MaterialType get() = types.firstOrNull() ?: MaterialType.report
    val dynamicResult: ValidationResult? get() = form?.let { FormValidator.validate(it, primaryType, values) }
    val titleLength: Int get() = title.codePointCount(0, title.length)
    val titleError: Boolean get() = titleLength !in 5..80
    val sensitivityMissing: Boolean get() = minors == null || injured == null || graphic == null
    val pseudonymMissing: Boolean get() = displayMode == DisplayName.Mode.pseudonym && pseudonym.isBlank()
    val fixedValid: Boolean get() = !titleError && types.isNotEmpty() && governorate.isNotBlank() && city.isNotBlank() && !sensitivityMissing && !pseudonymMissing
    /** How many things stop the current step, for the one summary line above the button (spec A1). */
    val stepProblems: Int get() = when (step) {
        1 -> if (original == null) 1 else 0
        2 -> listOf(titleError, types.isEmpty(), governorate.isBlank(), city.isBlank(), minors == null, injured == null, graphic == null, pseudonymMissing).count { it }
        3 -> dynamicResult?.errors?.size ?: 1
        else -> 0
    }
    val steps: List<Int> get() = if (attachTo != null) listOf(1, 4) else listOf(1, 2, 3, 4)
}

class NewMaterialViewModel(
    private val app: Application,
    private val container: AppContainer,
    private val draftId: String?,
    attachTo: String?,
) : ViewModel() {
    private val _state = MutableStateFlow(NewMaterialUiState(attachTo = attachTo))
    val state: StateFlow<NewMaterialUiState> = _state
    /** One key per draft: a retry of the same material after a network error replays, it does not duplicate. */
    private val materialIdempotencyKey = IdempotencyKey.generate()
    private val id = draftId ?: UUID.randomUUID().toString()
    private val formCache = File(app.filesDir, "form_cache.json")
    private val formAdapter = Serializer.moshi.adapter(UploadForm::class.java)

    init {
        if (attachTo == null) loadForm()
        else viewModelScope.launch {
            runCatching { container.materialsApi.getMaterial(UUID.fromString(attachTo)) }.onSuccess { m -> _state.update { it.copy(attachTitle = m.title) } }
        }
        if (draftId != null) viewModelScope.launch { restore(draftId) }
    }

    private suspend fun restore(draftId: String) {
        val d = container.database.drafts().get(draftId)?.let { MaterialDraft.fromJson(it.json) } ?: return
        _state.update { s ->
            s.copy(
                step = d.step, title = d.title, types = d.types.mapNotNull { v -> MaterialType.entries.firstOrNull { it.value == v } }.toSet(),
                governorate = d.governorate, city = d.city, priority = Priority.entries.firstOrNull { it.value == d.priority } ?: Priority.normal,
                minors = d.minors, injured = d.injured, graphic = d.graphic,
                displayMode = DisplayName.Mode.entries.firstOrNull { it.value == d.displayMode } ?: DisplayName.Mode.network, pseudonym = d.pseudonym,
                values = d.values, original = d.originalUri?.let { PickedOriginal(Uri.parse(it), d.originalName ?: "original", d.originalSize, d.originalMime) },
            )
        }
        _state.value.original?.let { describe(it) }
    }

    /** The current form; on failure the last one saved on the phone, marked as such (flows A1, "no network"). */
    fun loadForm() {
        _state.update { it.copy(formError = null) }
        viewModelScope.launch {
            try {
                val form = container.formsApi.getCurrentForm(null)
                withContext(Dispatchers.IO) { runCatching { formCache.writeText(formAdapter.toJson(form)) } }
                _state.update { it.copy(form = form, formCached = false) }
            } catch (t: Throwable) {
                val cached = withContext(Dispatchers.IO) { runCatching { formAdapter.fromJson(formCache.readText()) }.getOrNull() }
                _state.update { if (cached != null) it.copy(form = cached, formCached = true) else it.copy(formError = describeFailure(app, t)) }
            }
        }
    }

    fun update(block: NewMaterialUiState.() -> NewMaterialUiState) = _state.update { it.block().copy(error = null, draftSaved = false) }
    fun setValue(key: String, value: Any?) = _state.update { it.copy(values = it.values + (key to value), draftSaved = false) }
    fun setPicked(key: String, files: List<PickedFile>) = _state.update { it.copy(picked = it.picked + (key to files)) }

    fun pick(original: PickedOriginal) {
        _state.update { it.copy(original = original, thumbnail = null, durationMs = null, draftSaved = false) }
        describe(original)
    }

    /** Thumbnail and duration for the file card, read by the system without copying the file. */
    private fun describe(o: PickedOriginal) = viewModelScope.launch(Dispatchers.IO) {
        val thumb = runCatching { app.contentResolver.loadThumbnail(o.uri, Size(320, 180), null).asImageBitmap() }.getOrNull()
        val duration = if (o.mimeType?.startsWith("video/") == true) runCatching {
            MediaMetadataRetriever().run { try { setDataSource(app, o.uri); extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() } finally { release() } }
        }.getOrNull() else null
        _state.update { if (it.original?.uri == o.uri) it.copy(thumbnail = thumb, durationMs = duration) else it }
    }

    fun next() {
        val s = _state.value
        if (s.stepProblems > 0) { _state.update { it.copy(showErrors = true) }; return }
        val i = s.steps.indexOf(s.step)
        if (i < s.steps.lastIndex) _state.update { it.copy(step = s.steps[i + 1], showErrors = false) }
    }

    fun back(): Boolean {
        val s = _state.value
        val i = s.steps.indexOf(s.step)
        if (i <= 0) return false
        _state.update { it.copy(step = s.steps[i - 1], showErrors = false) }
        return true
    }

    fun goTo(step: Int) = _state.update { it.copy(step = step, showErrors = false) }

    /** Keeps the draft on the phone only, shown on A2 until it is sent. */
    fun saveDraft() = viewModelScope.launch {
        val s = _state.value
        val attachmentKeys = s.form?.fields?.filter { it.type == UploadFormField.Type.attachment }?.map { it.key }?.toSet().orEmpty()
        val d = MaterialDraft(
            title = s.title, types = s.types.map { it.value }, governorate = s.governorate, city = s.city, priority = s.priority.value,
            minors = s.minors, injured = s.injured, graphic = s.graphic, displayMode = s.displayMode.value, pseudonym = s.pseudonym,
            values = s.values.filterKeys { it !in attachmentKeys }, originalUri = s.original?.uri?.toString(), originalName = s.original?.name,
            originalSize = s.original?.sizeBytes ?: 0, originalMime = s.original?.mimeType, step = s.step,
        )
        container.database.drafts().upsert(DraftEntity(id, s.title, d.toJson(), System.currentTimeMillis()))
        _state.update { it.copy(draftSaved = true) }
    }

    fun submit() {
        val s = _state.value
        val attach = s.attachTo
        if (s.original == null || (attach == null && (!s.fixedValid || s.dynamicResult?.valid != true))) { _state.update { it.copy(showErrors = true) }; return }
        if (s.submitting) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            try {
                val materialId: String
                val title: String
                if (attach != null) {
                    materialId = attach; title = s.attachTitle
                } else {
                    val form = s.form!!
                    val visibleKeys = FormValidator.visibleFields(form, s.primaryType, s.values).map { it.key }.toSet()
                    val material = container.materialsApi.createMaterial(
                        materialIdempotencyKey,
                        MaterialCreate(
                            title = s.title, materialTypes = s.types, governorate = s.governorate.trim(), city = s.city.trim(),
                            priority = s.priority, sensitivity = Sensitivity(minors = s.minors!!, injured = s.injured!!, graphic = s.graphic!!),
                            displayName = DisplayName(mode = s.displayMode, pseudonym = s.pseudonym.takeIf { s.displayMode == DisplayName.Mode.pseudonym }),
                            formVersion = form.version,
                            dynamicFields = s.values.filterKeys { it in visibleKeys }.filterValues { it != null }.mapValues { it.value as Any },
                        ),
                    )
                    materialId = material.id.toString(); title = s.title
                }
                val original = s.original
                val task = UploadTask(
                    id = UUID.randomUUID().toString(), materialId = materialId, kind = "original",
                    fileUri = original.uri.toString(), filename = original.name, mimeType = original.mimeType, sizeBytes = original.sizeBytes,
                    idempotencyKey = IdempotencyKey.generate(), createdAtEpochMs = System.currentTimeMillis(),
                )
                container.uploadStore.insert(task, title = title, priority = if (attach == null) s.priority.value else null)
                if (draftId != null) container.database.drafts().delete(draftId)
                UploadScheduler.start(app, original.sizeBytes)
                _state.update { it.copy(submitting = false, createdTaskId = task.id) }
            } catch (t: Throwable) {
                _state.update { it.copy(submitting = false, error = describeFailure(app, t)) }
            }
        }
    }
}

@Composable
fun NewMaterialScreen(container: AppContainer, draftId: String?, attachToMaterialId: String?, onBack: () -> Unit, onQueued: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    val vm: NewMaterialViewModel = viewModel(key = "new-$draftId-$attachToMaterialId", factory = viewModelFactory { initializer { NewMaterialViewModel(app, container, draftId, attachToMaterialId) } })
    val s by vm.state.collectAsStateWithLifecycle()
    if (s.createdTaskId != null) { onQueued(); return }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        // The transfer outlives this screen and the process: keep read access for as long as the system allows.
        try { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (e: SecurityException) { /* provider does not persist grants */ }
        var name = "original"
        var size = 0L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { i -> if (!c.isNull(i)) size = c.getLong(i) }
            }
        }
        vm.pick(PickedOriginal(uri, name, size, context.contentResolver.getType(uri)))
    }
    val pickOriginal = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }
    androidx.activity.compose.BackHandler(enabled = s.step != s.steps.first()) { vm.back() }

    val stepNames = listOf(R.string.a1_step_file, R.string.a1_step_data, R.string.a1_step_form, R.string.a1_step_review)
    val position = s.steps.indexOf(s.step) + 1
    Scaffold(
        containerColor = Vl.colors.bgCanvas,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (s.attachTo != null) R.string.a1_title_replacement else R.string.material_new_title), style = Vl.text.headingH3) },
                navigationIcon = { TextButton(onClick = { if (!vm.back()) onBack() }) { Text(stringResource(R.string.action_back)) } },
                actions = { if (s.attachTo == null) GhostButton(stringResource(if (s.draftSaved) R.string.a1_draft_saved else R.string.a1_save_draft), { vm.saveDraft() }) },
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = VlSpace.s5, vertical = VlSpace.s4), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                if (s.showErrors && s.stepProblems > 0) Text(stringResource(R.string.a1_problems, s.stepProblems), style = Vl.text.bodySm, color = Vl.colors.textDanger)
                s.error?.let { Text(it, style = Vl.text.bodySm, color = Vl.colors.textDanger) }
                if (s.step == 4) PrimaryButton(stringResource(if (s.submitting) R.string.a1_creating else R.string.material_submit), vm::submit, enabled = !s.submitting)
                else PrimaryButton(stringResource(R.string.a1_next), vm::next, enabled = s.step != 3 || s.form != null)
                if (s.step == 1 && s.original == null) Text(stringResource(R.string.a1_next_needs_file), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = VlSpace.s5, vertical = VlSpace.s4),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s5),
        ) {
            Box(Modifier.widthIn(max = 560.dp).align(Alignment.CenterHorizontally)) {
                Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
                    Stepper(position, s.steps.size, stringResource(R.string.a1_step_caption, position, s.steps.size, stringResource(stepNames[s.step - 1])))
                    when (s.step) {
                        1 -> FileStep(s, pickOriginal)
                        2 -> DataStep(s, vm)
                        3 -> FormStep(s, vm)
                        else -> ReviewStep(s, vm::goTo)
                    }
                }
            }
        }
    }
}

@Composable
private fun FileStep(s: NewMaterialUiState, pick: () -> Unit) {
    if (s.attachTo != null) Text(stringResource(R.string.a1_replacement_for, s.attachTitle), style = Vl.text.bodyMd, color = Vl.colors.textSecondary)
    val o = s.original
    if (o == null) {
        // Dashed border and one action: pick from the gallery.
        val dash = Vl.colors.borderStrong
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(VlRadius.lg)).drawBehind {
                drawRoundRect(dash, style = Stroke(width = 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(16f, 12f))), cornerRadius = androidx.compose.ui.geometry.CornerRadius(VlRadius.lg.toPx()))
            }.padding(VlSpace.s6),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s4),
        ) {
            Icon(Icons.Outlined.PhotoLibrary, contentDescription = null, tint = Vl.colors.iconMuted, modifier = Modifier.size(VlSize.iconLg))
            Text(stringResource(R.string.a1_file_help), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
            SecondaryButton(stringResource(R.string.a1_pick_gallery), pick)
            if (s.showErrors) Text(stringResource(R.string.material_file_required), style = Vl.text.bodySm, color = Vl.colors.textDanger)
        }
    } else VlCard {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), verticalAlignment = Alignment.CenterVertically) {
            s.thumbnail?.let { Image(it, contentDescription = null, modifier = Modifier.size(width = VlSize.thumbW, height = VlSize.thumbH).clip(RoundedCornerShape(VlRadius.md))) }
            Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
                Text(o.name, style = Vl.text.labelMd, color = Vl.colors.textPrimary, maxLines = 2)
                val meta = listOfNotNull(FieldInput.describeBytes(o.sizeBytes), s.durationMs?.let { formatClip(it) }).joinToString(" · ")
                Text(meta, style = Vl.text.captionMd, color = Vl.colors.textSecondary)
            }
        }
        Text(stringResource(R.string.a1_original_as_is), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
        GhostButton(stringResource(R.string.a1_change_file), pick)
    }
}

private fun formatClip(ms: Long): String {
    val total = ms / 1000
    return if (total >= 3600) "%d:%02d:%02d".format(total / 3600, (total % 3600) / 60, total % 60) else "%d:%02d".format(total / 60, total % 60)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DataStep(s: NewMaterialUiState, vm: NewMaterialViewModel) {
    OutlinedTextField(
        value = s.title, onValueChange = { v -> vm.update { copy(title = v) } }, label = { Text(stringResource(R.string.material_title) + " *") },
        isError = s.showErrors && s.titleError, textStyle = Vl.text.bodyMd, singleLine = true, modifier = Modifier.fillMaxWidth(),
        supportingText = { Row { Text(stringResource(R.string.material_title_help), modifier = Modifier.weight(1f)); Text("${s.titleLength}/80") } },
    )
    Label(stringResource(R.string.material_types), required = true)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        for (t in MaterialType.entries) {
            val on = t in s.types
            FilterChip(selected = on, onClick = { vm.update { copy(types = if (on) types - t else types + t) } }, label = { Text(materialTypeLabel(t), style = Vl.text.labelMd) }, modifier = Modifier.heightIn(min = VlSize.touchMin))
        }
    }
    if (s.showErrors && s.types.isEmpty()) ErrorLine(stringResource(R.string.field_err_required))
    OutlinedTextField(value = s.governorate, onValueChange = { v -> vm.update { copy(governorate = v) } }, label = { Text(stringResource(R.string.material_governorate) + " *") }, isError = s.showErrors && s.governorate.isBlank(), textStyle = Vl.text.bodyMd, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(value = s.city, onValueChange = { v -> vm.update { copy(city = v) } }, label = { Text(stringResource(R.string.material_city) + " *") }, isError = s.showErrors && s.city.isBlank(), textStyle = Vl.text.bodyMd, singleLine = true, modifier = Modifier.fillMaxWidth())

    Label(stringResource(R.string.material_priority), required = true)
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        Priority.entries.forEachIndexed { i, p ->
            val tone = toneColors(priorityTone(p))
            SegmentedButton(
                selected = s.priority == p, onClick = { vm.update { copy(priority = p) } }, shape = SegmentedButtonDefaults.itemShape(i, Priority.entries.size),
                colors = SegmentedButtonDefaults.colors(activeContainerColor = tone.bg, activeContentColor = tone.fg, activeBorderColor = tone.border),
            ) { Text(priorityLabel(p), style = Vl.text.labelMd) }
        }
    }

    Label(stringResource(R.string.material_sensitivity), required = true)
    Text(stringResource(R.string.material_sensitivity_help), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
    YesNo(stringResource(R.string.material_sensitivity_minors), s.minors, s.showErrors) { v -> vm.update { copy(minors = v) } }
    YesNo(stringResource(R.string.material_sensitivity_injured), s.injured, s.showErrors) { v -> vm.update { copy(injured = v) } }
    YesNo(stringResource(R.string.material_sensitivity_graphic), s.graphic, s.showErrors) { v -> vm.update { copy(graphic = v) } }
    if (s.showErrors && s.sensitivityMissing) ErrorLine(stringResource(R.string.material_sensitivity_required))

    DisplayModePicker(s.displayMode) { m -> vm.update { copy(displayMode = m) } }
    if (s.displayMode == DisplayName.Mode.pseudonym) {
        OutlinedTextField(value = s.pseudonym, onValueChange = { v -> vm.update { copy(pseudonym = v) } }, label = { Text(stringResource(R.string.material_pseudonym) + " *") }, isError = s.showErrors && s.pseudonymMissing, textStyle = Vl.text.bodyMd, singleLine = true, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun FormStep(s: NewMaterialUiState, vm: NewMaterialViewModel) {
    when {
        s.form != null -> {
            Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
                SectionTitle(stringResource(R.string.form_title) + " · " + stringResource(R.string.form_version, s.form.version))
                if (s.formCached) StateBadge(null, stringResource(R.string.a1_form_cached), Tone.NEUTRAL)
            }
            DynamicForm(s.form, s.primaryType, s.values, if (s.showErrors) s.dynamicResult else null, s.picked, vm::setValue, vm::setPicked)
        }
        s.formError != null -> InlineAlert(Tone.ATTENTION, stringResource(R.string.a1_form_unavailable) + "\n" + s.formError) {
            SecondaryButton(stringResource(R.string.action_retry), vm::loadForm)
        }
        else -> Text(stringResource(R.string.home_loading), style = Vl.text.bodyMd)
    }
}

@Composable
private fun ReviewStep(s: NewMaterialUiState, goTo: (Int) -> Unit) {
    if (s.attachTo == null) {
        Summary(stringResource(R.string.a1_step_data), onEdit = { goTo(2) }) {
            Line(stringResource(R.string.material_title), s.title)
            Line(stringResource(R.string.material_types), s.types.map { materialTypeLabel(it) }.joinToString("، "))
            Line(stringResource(R.string.material_governorate), s.governorate + " · " + s.city)
            Line(stringResource(R.string.material_priority), priorityLabel(s.priority))
            Line(stringResource(R.string.material_display_name), displayModeLabel(s.displayMode))
        }
        Summary(stringResource(R.string.a1_step_form), onEdit = { goTo(3) }) {
            Line(stringResource(R.string.form_title), s.form?.let { stringResource(R.string.form_version, it.version) } ?: "—")
        }
    }
    Summary(stringResource(R.string.a1_what_uploads), onEdit = { goTo(1) }) {
        s.original?.let { Line(stringResource(R.string.a1_the_original), it.name + " · " + FieldInput.describeBytes(it.sizeBytes)) }
        Text(stringResource(R.string.a1_original_as_is), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
    }
}

@Composable
private fun Summary(title: String, onEdit: () -> Unit, content: @Composable () -> Unit) {
    var open by remember { mutableStateOf(true) }
    VlCard(gap = VlSpace.s3) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { open = !open }.semantics { stateDescription = if (open) "expanded" else "collapsed" }) {
            Text(title, style = Vl.text.labelLg, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
            GhostButton(stringResource(R.string.a1_edit), onEdit)
        }
        if (open) content()
    }
}

@Composable
private fun Line(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), modifier = Modifier.fillMaxWidth()) {
        Text(label, style = Vl.text.labelMd, color = Vl.colors.textSecondary, modifier = Modifier.weight(0.4f))
        Text(value, style = Vl.text.bodySm, color = Vl.colors.textPrimary, modifier = Modifier.weight(0.6f))
    }
}

@Composable
private fun Label(text: String, required: Boolean) {
    val requiredText = stringResource(R.string.a1_required)
    Text(text + if (required) " *" else "", style = Vl.text.labelLg, color = Vl.colors.textPrimary, modifier = Modifier.semantics { if (required) contentDescription = "$text, $requiredText" })
}

@Composable
private fun ErrorLine(text: String) = Text(text, style = Vl.text.bodySm, color = Vl.colors.textDanger)

/** A required yes/no with no default (spec A1): neither answer is selected until the reporter picks one. */
@Composable
private fun YesNo(label: String, value: Boolean?, showErrors: Boolean, onChange: (Boolean) -> Unit) {
    val requiredText = stringResource(R.string.a1_required)
    Text(label, style = Vl.text.bodyMd, color = if (showErrors && value == null) Vl.colors.textDanger else Vl.colors.textPrimary, modifier = Modifier.semantics { contentDescription = "$label, $requiredText" })
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        SegmentedButton(selected = value == true, onClick = { onChange(true) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.form_bool_yes), style = Vl.text.labelMd) }
        SegmentedButton(selected = value == false, onClick = { onChange(false) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.form_bool_no), style = Vl.text.labelMd) }
    }
}

@Composable
private fun DisplayModePicker(current: DisplayName.Mode, onPick: (DisplayName.Mode) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = displayModeLabel(current), onValueChange = {}, readOnly = true, label = { Text(stringResource(R.string.material_display_name)) }, textStyle = Vl.text.bodyMd,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (m in DisplayName.Mode.entries) DropdownMenuItem(text = { Text(displayModeLabel(m)) }, onClick = { onPick(m); expanded = false })
        }
    }
}

@Composable
fun priorityLabel(p: Priority): String = stringResource(when (p.value) { "urgent" -> R.string.priority_urgent; "important" -> R.string.priority_important; else -> R.string.priority_normal })

@Composable
fun displayModeLabel(m: DisplayName.Mode): String = stringResource(when (m) { DisplayName.Mode.real_name -> R.string.display_real_name; DisplayName.Mode.pseudonym -> R.string.display_pseudonym; DisplayName.Mode.network -> R.string.display_network })
