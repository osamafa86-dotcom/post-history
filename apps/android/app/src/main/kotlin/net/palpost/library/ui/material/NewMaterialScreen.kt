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
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.saveable.rememberSaveable
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
import net.palpost.library.ui.theme.MinTouchTarget
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

/** What the system read from one picked file for its row: thumbnail and (videos) length, never copied anywhere. */
data class FileDetail(val thumbnail: ImageBitmap? = null, val durationMs: Long? = null)

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
    /** The originals of this one material, in the order they will be queued; up to [PickedFiles.MAX]. */
    val originals: List<PickedOriginal> = emptyList(),
    /** Row details by content URI. */
    val details: Map<String, FileDetail> = emptyMap(),
    /** Files of the last pick that did not enter the list: the same file twice, or beyond the limit. */
    val skippedDuplicates: Int = 0,
    val skippedOverLimit: Int = 0,
    val showErrors: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val createdTaskId: String? = null,
    /** "Upload a replacement shot" (A4): the file goes to this existing material; steps 2 and 3 do not apply. */
    val attachTo: String? = null,
    val attachTitle: String = "",
    val draftSaved: Boolean = false,
    /** Something was typed or picked since the screen opened or the draft was last saved: leaving asks first. */
    val dirty: Boolean = false,
) {
    val primaryType: MaterialType get() = types.firstOrNull() ?: MaterialType.report
    val dynamicResult: ValidationResult? get() = form?.let { FormValidator.validate(it, primaryType, values) }
    val titleLength: Int get() = title.codePointCount(0, title.length)
    /** Files in the batch: each becomes its own material and gets `(i/N)` after the title, so the base title must leave room for it. */
    val batchSize: Int get() = PickedFiles.groupSize(originals).coerceAtLeast(1)
    val titleMax: Int get() = MaterialTitles.maxBase(batchSize)
    val titleError: Boolean get() = titleLength !in MaterialTitles.MIN..titleMax
    val sensitivityMissing: Boolean get() = minors == null || injured == null || graphic == null
    val pseudonymMissing: Boolean get() = displayMode == DisplayName.Mode.pseudonym && pseudonym.isBlank()
    val fixedValid: Boolean get() = !titleError && types.isNotEmpty() && governorate.isNotBlank() && city.isNotBlank() && !sensitivityMissing && !pseudonymMissing
    /** How many things stop the current step, for the one summary line above the button (spec A1). */
    val stepProblems: Int get() = when (step) {
        1 -> if (originals.isEmpty()) 1 else 0
        2 -> listOf(titleError, types.isEmpty(), governorate.isBlank(), city.isBlank(), minors == null, injured == null, graphic == null, pseudonymMissing).count { it }
        3 -> dynamicResult?.errors?.size ?: 1
        4 -> if (attachTo == null && titleError) 1 else 0 // files added after the title was typed can make it too long for the numbering
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
    /** The draft-level key: a draft saved before multi-pick (one file, no key of its own) creates its material with it. */
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
                values = d.values, originals = PickedFiles.stampKeys(if (s.attachTo != null) d.files.take(1) else d.files, materialIdempotencyKey, IdempotencyKey::generate),
            )
        }
        _state.value.originals.forEach { describe(it) }
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

    fun update(block: NewMaterialUiState.() -> NewMaterialUiState) = _state.update { it.block().copy(error = null, draftSaved = false, dirty = true) }
    fun setValue(key: String, value: Any?) = _state.update { it.copy(values = it.values + (key to value), draftSaved = false, dirty = true) }
    fun setPicked(key: String, files: List<PickedFile>) = _state.update { it.copy(picked = it.picked + (key to files), dirty = true) }

    /** More originals for the same material (one title, one form): appended in the order picked, nothing dropped silently. */
    fun addFiles(incoming: List<PickedOriginal>) {
        if (incoming.isEmpty()) return
        val result = PickedFiles.add(_state.value.originals, incoming)
        _state.update { it.copy(originals = result.files, skippedDuplicates = result.duplicates, skippedOverLimit = result.overLimit, draftSaved = false, dirty = it.dirty || result.added > 0, error = null) }
        result.files.takeLast(result.added).forEach { describe(it) }
    }

    /** "Upload a replacement shot" stays a single pick: the new file replaces the old one. */
    fun replaceFile(original: PickedOriginal) {
        _state.update { it.copy(originals = listOf(original), skippedDuplicates = 0, skippedOverLimit = 0, draftSaved = false, dirty = true) }
        describe(original)
    }

    /** Drops one row from the list. The file on the phone and the upload queue are untouched. */
    fun removeFile(uri: String) = _state.update {
        it.copy(originals = PickedFiles.remove(it.originals, uri), details = it.details - uri, skippedDuplicates = 0, skippedOverLimit = 0, draftSaved = false, dirty = true)
    }

    /** Thumbnail and duration for the file row, read by the system without copying the file. */
    private fun describe(o: PickedOriginal) = viewModelScope.launch(Dispatchers.IO) {
        val uri = Uri.parse(o.uri)
        val thumb = runCatching { app.contentResolver.loadThumbnail(uri, Size(320, 180), null).asImageBitmap() }.getOrNull()
        val duration = if (o.isVideo) runCatching {
            MediaMetadataRetriever().run { try { setDataSource(app, uri); extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() } finally { release() } }
        }.getOrNull() else null
        _state.update { if (it.originals.any { f -> f.uri == o.uri }) it.copy(details = it.details + (o.uri to FileDetail(thumb, duration))) else it }
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

    /** Keeps the draft on the phone only, shown on A2 until it is sent. [onSaved] runs once it is written (leaving the screen). */
    fun saveDraft(onSaved: () -> Unit = {}) = viewModelScope.launch {
        writeDraft()
        onSaved()
    }

    /** Writes the current state as the draft: with the files still to send only, each with its key and its material id if created. */
    private suspend fun writeDraft() {
        val s = _state.value
        val attachmentKeys = s.form?.fields?.filter { it.type == UploadFormField.Type.attachment }?.map { it.key }?.toSet().orEmpty()
        val d = MaterialDraft(
            title = s.title, types = s.types.map { it.value }, governorate = s.governorate, city = s.city, priority = s.priority.value,
            minors = s.minors, injured = s.injured, graphic = s.graphic, displayMode = s.displayMode.value, pseudonym = s.pseudonym,
            values = s.values.filterKeys { it !in attachmentKeys }, files = s.originals, step = s.step,
        )
        container.database.drafts().upsert(DraftEntity(id, s.title, d.toJson(), System.currentTimeMillis()))
        _state.update { it.copy(draftSaved = true, dirty = false) }
    }

    fun submit() {
        val s = _state.value
        val attach = s.attachTo
        if (s.originals.isEmpty() || (attach == null && (!s.fixedValid || s.dynamicResult?.valid != true))) { _state.update { it.copy(showErrors = true) }; return }
        if (s.submitting) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            if (attach != null) submitReplacement(s, attach) else submitBatch(s)
        }
    }

    /** A replacement shot goes to its existing material: one file, no new material. */
    private suspend fun submitReplacement(s: NewMaterialUiState, materialId: String) {
        try {
            val original = s.originals.first()
            val task = UploadTask(
                id = UUID.randomUUID().toString(), materialId = materialId, kind = "original",
                fileUri = original.uri, filename = original.name, mimeType = original.mimeType, sizeBytes = original.sizeBytes,
                idempotencyKey = IdempotencyKey.generate(), createdAtEpochMs = System.currentTimeMillis(),
            )
            container.uploadStore.insert(task, title = s.attachTitle, priority = null)
            UploadScheduler.start(app, original.sizeBytes)
            _state.update { it.copy(submitting = false, dirty = false, createdTaskId = task.id) }
        } catch (t: Throwable) {
            _state.update { it.copy(submitting = false, error = describeFailure(app, t)) }
        }
    }

    /**
     * One material per file (the server keeps one original per material), all with the details typed once. Per file, in order:
     * create the material (skipped if the file already has its material id), then queue its upload, then drop it from the list.
     * Keys and row ids are stable, so nothing is created or queued twice; on a failure the files still to send are saved as the draft.
     */
    private suspend fun submitBatch(s: NewMaterialUiState) {
        val form = s.form!!
        val visibleKeys = FormValidator.visibleFields(form, s.primaryType, s.values).map { it.key }.toSet()
        val files = PickedFiles.assignPositions(PickedFiles.stampKeys(s.originals, materialIdempotencyKey, IdempotencyKey::generate))
        _state.update { it.copy(originals = files) }
        val now = System.currentTimeMillis()
        fun titleOf(f: PickedOriginal) = MaterialTitles.titleFor(s.title, f.position!!, f.total!!)
        val result = MaterialBatch.run(
            files,
            createMaterial = { f ->
                container.materialsApi.createMaterial(
                    f.materialKey!!,
                    MaterialCreate(
                        title = titleOf(f), materialTypes = s.types, governorate = s.governorate.trim(), city = s.city.trim(),
                        priority = s.priority, sensitivity = Sensitivity(minors = s.minors!!, injured = s.injured!!, graphic = s.graphic!!),
                        displayName = DisplayName(mode = s.displayMode, pseudonym = s.pseudonym.takeIf { s.displayMode == DisplayName.Mode.pseudonym }),
                        formVersion = form.version,
                        dynamicFields = s.values.filterKeys { it in visibleKeys }.filterValues { it != null }.mapValues { it.value as Any },
                    ),
                ).id.toString()
            },
            enqueue = { f, materialId ->
                val task = UploadTask(
                    id = UploadIds.taskId(materialId), materialId = materialId, kind = "original",
                    fileUri = f.uri, filename = f.name, mimeType = f.mimeType, sizeBytes = f.sizeBytes,
                    idempotencyKey = UploadIds.sessionKey(materialId), createdAtEpochMs = now + f.position!!, // the queue runs oldest first
                )
                container.uploadStore.insert(task, title = titleOf(f), priority = s.priority.value)
                task.id
            },
            onProgress = { rest -> _state.update { st -> st.copy(originals = rest, details = st.details.filterKeys { k -> rest.any { it.uri == k } }) } },
        )
        val queuedBytes = files.filter { f -> result.remaining.none { it.uri == f.uri } }.sumOf { it.sizeBytes.coerceAtLeast(0) }
        if (result.queuedTaskIds.isNotEmpty()) UploadScheduler.start(app, queuedBytes)
        val failure = result.failure
        if (failure == null) {
            container.database.drafts().delete(id)
            _state.update { it.copy(submitting = false, dirty = false, createdTaskId = result.queuedTaskIds.first()) }
        } else {
            // What is left (the failed file with its material id if it has one, and the rest) is kept as the draft.
            runCatching { writeDraft() }
            val note = if (result.queuedTaskIds.isNotEmpty()) "\n" + app.getString(R.string.a1_partial_failed, result.queuedTaskIds.size, files.size, result.remaining.size) else ""
            _state.update { it.copy(submitting = false, error = describeFailure(app, failure) + note) }
        }
    }
}

@Composable
fun NewMaterialScreen(container: AppContainer, draftId: String?, attachToMaterialId: String?, onBack: () -> Unit, onQueued: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    // A fresh view model per visit: leaving by "discard" (or after queuing) must not bring the old input back on the next visit.
    val visit = rememberSaveable { UUID.randomUUID().toString() }
    val vm: NewMaterialViewModel = viewModel(key = "new-$draftId-$attachToMaterialId-$visit", factory = viewModelFactory { initializer { NewMaterialViewModel(app, container, draftId, attachToMaterialId) } })
    val s by vm.state.collectAsStateWithLifecycle()
    if (s.createdTaskId != null) { onQueued(); return }

    // Reads name, size and type of a picked file and keeps read access for as long as the system allows.
    fun describePicked(uri: Uri): PickedOriginal {
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
        // The key that creates this file's material, fixed now so every retry (and a saved draft) replays the same request.
        return PickedOriginal(uri.toString(), name, size, context.contentResolver.getType(uri), materialKey = IdempotencyKey.generate())
    }
    // Several originals for one material (up to PickedFiles.MAX); the files of one pick enter the list in the order the picker returns them.
    val multiPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PickedFiles.MAX)) { uris ->
        vm.addFiles(uris.map { describePicked(it) })
    }
    // The replacement shot of an existing material is still one file.
    val singlePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) vm.replaceFile(describePicked(uri))
    }
    val pickOriginals: () -> Unit = {
        if (s.attachTo != null) singlePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        else multiPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
    }

    // Leaving with unsaved input asks first (save the draft / discard / keep editing); enqueued uploads are never touched by it.
    var confirmLeave by rememberSaveable { mutableStateOf(false) }
    val requestLeave: () -> Unit = { if (s.dirty) { confirmLeave = true } else { onBack() } }
    androidx.activity.compose.BackHandler { if (!vm.back()) requestLeave() }
    if (confirmLeave) LeaveDialog(
        canSaveDraft = s.attachTo == null,
        onSave = { confirmLeave = false; vm.saveDraft(onSaved = onBack) },
        onDiscard = { confirmLeave = false; onBack() },
        onKeep = { confirmLeave = false },
    )

    val stepNames = listOf(R.string.a1_step_file, R.string.a1_step_data, R.string.a1_step_form, R.string.a1_step_review)
    val position = s.steps.indexOf(s.step) + 1
    Scaffold(
        containerColor = Vl.colors.bgCanvas,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (s.attachTo != null) R.string.a1_title_replacement else R.string.material_new_title), style = Vl.text.headingH3) },
                navigationIcon = { TextButton(onClick = { if (!vm.back()) requestLeave() }) { Text(stringResource(R.string.action_back)) } },
                actions = { if (s.attachTo == null) GhostButton(stringResource(if (s.draftSaved) R.string.a1_draft_saved else R.string.a1_save_draft), { vm.saveDraft() }) },
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = VlSpace.s5, vertical = VlSpace.s4), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                if (s.showErrors && s.stepProblems > 0) Text(stringResource(R.string.a1_problems, s.stepProblems), style = Vl.text.bodySm, color = Vl.colors.textDanger)
                s.error?.let { Text(it, style = Vl.text.bodySm, color = Vl.colors.textDanger) }
                if (s.step == 4) PrimaryButton(stringResource(if (s.submitting) R.string.a1_creating else R.string.material_submit), vm::submit, enabled = !s.submitting)
                else PrimaryButton(stringResource(R.string.a1_next), vm::next, enabled = s.step != 3 || s.form != null)
                if (s.step == 1 && s.originals.isEmpty()) Text(stringResource(R.string.a1_next_needs_file), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
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
                        1 -> FileStep(s, pickOriginals, vm::removeFile)
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
private fun FileStep(s: NewMaterialUiState, pick: () -> Unit, remove: (String) -> Unit) {
    val replacing = s.attachTo != null
    if (replacing) Text(stringResource(R.string.a1_replacement_for, s.attachTitle), style = Vl.text.bodyMd, color = Vl.colors.textSecondary)
    if (s.originals.isEmpty()) {
        // Dashed border and one action: pick from the gallery.
        val dash = Vl.colors.borderStrong
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(VlRadius.lg)).drawBehind {
                drawRoundRect(dash, style = Stroke(width = 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(16f, 12f))), cornerRadius = androidx.compose.ui.geometry.CornerRadius(VlRadius.lg.toPx()))
            }.padding(VlSpace.s6),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s4),
        ) {
            Icon(Icons.Outlined.PhotoLibrary, contentDescription = null, tint = Vl.colors.iconMuted, modifier = Modifier.size(VlSize.iconLg))
            Text(if (replacing) stringResource(R.string.a1_file_help) else stringResource(R.string.a1_files_help, PickedFiles.MAX), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
            SecondaryButton(stringResource(if (replacing) R.string.a1_pick_gallery else R.string.a1_pick_gallery_many), pick)
            if (s.showErrors) Text(stringResource(R.string.material_file_required), style = Vl.text.bodySm, color = Vl.colors.textDanger)
        }
    } else if (replacing) {
        val o = s.originals.first()
        VlCard {
            FileRow(o, s.details[o.uri], onRemove = null)
            Text(stringResource(R.string.a1_original_as_is), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
            GhostButton(stringResource(R.string.a1_change_file), pick)
        }
    } else {
        // One material, many originals: each row can be dropped before sending (the file on the phone is not touched).
        Text(stringResource(R.string.a1_files_total, s.originals.size, PickedFiles.MAX, FieldInput.describeBytes(PickedFiles.totalBytes(s.originals))), style = Vl.text.labelMd, color = Vl.colors.textSecondary)
        for (o in s.originals) VlCard(gap = VlSpace.s3) { FileRow(o, s.details[o.uri], onRemove = { remove(o.uri) }) }
        if (s.skippedOverLimit > 0) InlineAlert(Tone.ATTENTION, stringResource(R.string.a1_files_over_limit, PickedFiles.MAX, s.skippedOverLimit))
        if (s.skippedDuplicates > 0) InlineAlert(Tone.NEUTRAL, stringResource(R.string.a1_files_duplicates, s.skippedDuplicates))
        Text(stringResource(R.string.a1_original_as_is), style = Vl.text.bodySm, color = Vl.colors.textSecondary)
        SecondaryButton(stringResource(R.string.a1_add_more), pick, enabled = PickedFiles.remaining(s.originals) > 0)
    }
}

/** One picked file: thumbnail when the system gave one, name, size and (videos) length; [onRemove] drops the row only. */
@Composable
private fun FileRow(o: PickedOriginal, d: FileDetail?, onRemove: (() -> Unit)?) {
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s4), verticalAlignment = Alignment.CenterVertically) {
        d?.thumbnail?.let { Image(it, contentDescription = null, modifier = Modifier.size(width = VlSize.thumbW, height = VlSize.thumbH).clip(RoundedCornerShape(VlRadius.md))) }
        Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s1), modifier = Modifier.weight(1f)) {
            Text(o.name, style = Vl.text.labelMd, color = Vl.colors.textPrimary, maxLines = 2)
            val meta = listOfNotNull(FieldInput.describeBytes(o.sizeBytes), d?.durationMs?.let { formatClip(it) }).joinToString(" · ")
            Text(meta, style = Vl.text.captionMd, color = Vl.colors.textSecondary)
        }
        if (onRemove != null) IconButton(onClick = onRemove, modifier = Modifier.size(MinTouchTarget)) {
            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.a1_remove_file, o.name), tint = Vl.colors.iconMuted)
        }
    }
}

/** Back with unsaved input: save the draft, discard it, or keep editing (dismissing the dialog keeps editing). */
@Composable
private fun LeaveDialog(canSaveDraft: Boolean, onSave: () -> Unit, onDiscard: () -> Unit, onKeep: () -> Unit) {
    AlertDialog(
        onDismissRequest = onKeep,
        title = { Text(stringResource(R.string.a1_leave_title), style = Vl.text.headingH4) },
        text = { Text(stringResource(if (canSaveDraft) R.string.a1_leave_body else R.string.a1_leave_body_no_draft), style = Vl.text.bodySm) },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                if (canSaveDraft) TextButton(onClick = onSave, modifier = Modifier.heightIn(min = MinTouchTarget)) { Text(stringResource(R.string.a1_leave_save), style = Vl.text.labelLg) }
                TextButton(onClick = onKeep, modifier = Modifier.heightIn(min = MinTouchTarget)) { Text(stringResource(R.string.a1_leave_keep), style = Vl.text.labelLg) }
                TextButton(onClick = onDiscard, modifier = Modifier.heightIn(min = MinTouchTarget), colors = ButtonDefaults.textButtonColors(contentColor = Vl.colors.textDanger)) {
                    Text(stringResource(R.string.a1_leave_discard), style = Vl.text.labelLg)
                }
            }
        },
    )
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
        supportingText = {
            Row {
                Text(
                    if (s.batchSize > 1) stringResource(R.string.a1_title_help_many, s.titleMax, ltr(MaterialTitles.longestSuffix(s.batchSize).trim())) else stringResource(R.string.material_title_help),
                    modifier = Modifier.weight(1f),
                )
                Text("${s.titleLength}/${s.titleMax}")
            }
        },
    )
    if (s.batchSize > 1 && s.titleLength > s.titleMax) ErrorLine(stringResource(R.string.a1_title_too_long_many, s.batchSize, s.titleMax))
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
            Line(stringResource(R.string.material_title), reviewTitles(s))
            if (s.batchSize > 1 && s.titleLength > s.titleMax) ErrorLine(stringResource(R.string.a1_title_too_long_many, s.batchSize, s.titleMax))
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
        if (s.originals.size == 1) s.originals.first().let { Line(stringResource(R.string.a1_the_original), it.name + " · " + FieldInput.describeBytes(it.sizeBytes)) }
        else if (s.originals.size > 1) Line(stringResource(R.string.a1_the_originals), stringResource(R.string.a1_review_materials, s.originals.size, FieldInput.describeBytes(PickedFiles.totalBytes(s.originals))))
        Text(stringResource(R.string.a1_original_as_is), style = Vl.text.captionMd, color = Vl.colors.textSecondary)
    }
}

/** Wraps text that must read left to right (numbers, slash, brackets) inside Arabic text; display only, never stored or sent. */
private fun ltr(text: String): String = "\u2066$text\u2069"

/** The title line of the review: the typed title, or with several files the first and the last numbered title. */
private fun reviewTitles(s: NewMaterialUiState): String {
    val n = s.batchSize
    if (n <= 1) return s.title
    return s.title + " " + ltr(MaterialTitles.suffix(1, n).trim()) + " … " + s.title + " " + ltr(MaterialTitles.suffix(n, n).trim())
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
