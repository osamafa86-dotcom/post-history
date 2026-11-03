package net.palpost.library.ui.send

import android.app.Application
import android.content.Intent
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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
import net.palpost.library.api.models.GpsPoint
import net.palpost.library.api.models.MaterialCreate
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.Sensitivity
import net.palpost.library.api.models.UploadForm
import net.palpost.library.api.models.UploadFormField
import net.palpost.library.core.forms.FormValidator
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.send.CaptureDate
import net.palpost.library.core.send.FormState
import net.palpost.library.core.send.GpsFix
import net.palpost.library.core.send.GpsPolicy
import net.palpost.library.core.send.MaterialTagRules
import net.palpost.library.core.send.ReporterMemory
import net.palpost.library.core.send.SendFormCheck
import net.palpost.library.core.send.SendReadiness
import net.palpost.library.core.send.SensitivityAnswers
import net.palpost.library.core.send.SensitivityGate
import net.palpost.library.core.send.TagSuggestions
import net.palpost.library.core.upload.UploadTask
import net.palpost.library.data.DraftEntity
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.forms.PickedFile
import net.palpost.library.ui.material.MaterialBatch
import net.palpost.library.ui.material.MaterialDraft
import net.palpost.library.ui.material.MaterialTitles
import net.palpost.library.ui.material.PickedFiles
import net.palpost.library.ui.material.PickedOriginal
import net.palpost.library.ui.material.UploadIds
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.upload.UriGrants
import java.io.File
import java.math.BigDecimal
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

/** What the system read from one picked file for its tile: thumbnail and (videos) length, never copied anywhere. */
data class FileDetail(val thumbnail: ImageBitmap? = null, val durationMs: Long? = null)

/** Why the typed tag was not added (under the tag field). */
enum class TagError { TOO_LONG, LIMIT, DUPLICATE }

data class SendUiState(
    val originals: List<PickedOriginal> = emptyList(),
    val details: Map<String, FileDetail> = emptyMap(),
    val skippedDuplicates: Int = 0,
    val skippedOverLimit: Int = 0,
    val title: String = "",
    val types: Set<MaterialType> = emptySet(),
    val tags: List<String> = emptyList(),
    /** Typed in the tag field and not yet committed. */
    val tagText: String = "",
    val tagError: TagError? = null,
    val governorate: String = "",
    val city: String = "",
    val editingPlace: Boolean = false,
    val priority: Priority = Priority.normal,
    val sensitivity: SensitivityAnswers = SensitivityAnswers(),
    val displayMode: DisplayName.Mode = DisplayName.Mode.real_name,
    val pseudonym: String = "",
    val form: UploadForm? = null,
    /** The form shown is the last one saved on the phone, because the current one could not be fetched. */
    val formCached: Boolean = false,
    val formError: String? = null,
    val values: Map<String, Any?> = emptyMap(),
    val picked: Map<String, List<PickedFile>> = emptyMap(),
    val moreOpen: Boolean = false,
    val memory: ReporterMemory = ReporterMemory(),
    val submitting: Boolean = false,
    val error: String? = null,
    /** The send went through: the screen closes and the upload screen opens. */
    val sentBatchId: String? = null,
    val draftSaved: Boolean = false,
    /** Something was typed or picked since the screen opened or the draft was last saved: leaving asks first. */
    val dirty: Boolean = false,
) {
    val primaryType: MaterialType get() = types.firstOrNull() ?: MaterialType.report
    /** Files in the send: each becomes its own material with `(i/N)` after the title, so the base title must leave room. */
    val batchSize: Int get() = PickedFiles.groupSize(originals).coerceAtLeast(1)
    val titleMax: Int get() = MaterialTitles.maxBase(batchSize)
    val titleLength: Int get() = MaterialTitles.length(title.trim())
    private val pinnedSuffixMax: Int get() = originals.mapNotNull { f -> f.position?.let { p -> f.total?.let { MaterialTitles.suffix(p, it).length } } }.maxOrNull() ?: 0
    val pseudonymMissing: Boolean get() = displayMode == DisplayName.Mode.pseudonym && pseudonym.isBlank()
    val formCheck: SendFormCheck? get() = form?.let { SendFormCheck(it, primaryType, values) }
    val formState: FormState get() = when {
        form != null -> formCheck!!.state
        formError != null -> FormState.UNAVAILABLE
        else -> FormState.LOADING
    }
    val reasons: List<SendReadiness.Reason> get() = SendReadiness.reasons(
        SendReadiness.Snapshot(
            fileCount = originals.size, title = title, titleMax = titleMax, pinnedSuffixMax = pinnedSuffixMax, typeCount = types.size,
            tags = tags, pendingTag = tagText, governorate = governorate, city = city, sensitivity = sensitivity,
            pseudonymMissing = pseudonymMissing, form = formState,
        ),
    )
    val reason: SendReadiness.Reason? get() = reasons.firstOrNull()
    /** The form is what stops the send: «required» shows under its empty fields. */
    val revealFormErrors: Boolean get() = reason?.isFormError == true
    val tagSuggestions: List<String> get() = TagSuggestions.match(tagText, memory.recentTags, tags)
    val placeRemembered: Boolean get() = memory.isRemembered(governorate.trim(), city.trim())
}

/**
 * 04 · the one send screen (ADR 0088 on Android): files (up to 20, one material each, ADR 0082) → coverage title → type → tags →
 * remembered place and «urgent» → the sensitivity question → required office fields → «More». One send is one entry in the
 * ledger (one receipt), and the filming location goes with each material it creates (ADR 0087).
 */
class SendViewModel(
    private val app: Application,
    private val container: AppContainer,
    private val draftId: String?,
) : ViewModel() {
    private val _state = MutableStateFlow(SendUiState())
    val state: StateFlow<SendUiState> = _state
    /** The draft-level key: a draft saved before multi-pick (one file, no key of its own) creates its material with it. */
    private val materialIdempotencyKey = IdempotencyKey.generate()
    private val id = draftId ?: UUID.randomUUID().toString()
    private val formCache = File(app.filesDir, "form_cache.json")
    private val formAdapter = Serializer.moshi.adapter(UploadForm::class.java)
    /** URIs of the files in the draft as last saved or opened; their grants stay until a save no longer holds them. */
    private var savedUris: Set<String> = emptySet()
    private val location = DeviceLocation(app)
    /** The fix read when the screen opened; memory only. */
    private var screenFix: GpsFix? = null
    /** The location of the send this draft is the rest of (sealed in the draft row); it wins over a new reading. */
    private var draftFix: GpsFix? = null

    init {
        viewModelScope.launch {
            val memory = withContext(Dispatchers.IO) { container.reporterMemory.load() }
            _state.update { s ->
                s.copy(
                    memory = memory,
                    governorate = if (draftId == null && memory.hasPlace) memory.governorate else s.governorate,
                    city = if (draftId == null && memory.hasPlace) memory.city else s.city,
                    displayMode = if (draftId == null) DisplayName.Mode.entries.firstOrNull { it.value == memory.effectiveDisplayMode } ?: DisplayName.Mode.real_name else s.displayMode,
                    pseudonym = if (draftId == null && memory.effectiveDisplayMode == "pseudonym") memory.pseudonym else s.pseudonym,
                    editingPlace = draftId == null && !memory.hasPlace,
                )
            }
            if (draftId != null) restore(draftId)
        }
        loadForm()
        viewModelScope.launch { screenFix = location.current() }
    }

    private suspend fun restore(draftId: String) {
        val row = container.database.drafts().get(draftId) ?: return
        val d = MaterialDraft.fromJson(row.json) ?: return
        draftFix = row.sealedGps?.let { sealed -> runCatching { GpsFix.decode(container.sealer.openString(sealed)) }.getOrNull() }
        _state.update { s ->
            s.copy(
                title = d.title, types = d.types.mapNotNull { v -> MaterialType.entries.firstOrNull { it.value == v } }.toSet(),
                tags = d.tags.filter(MaterialTagRules::isValid).distinct().take(MaterialTagRules.MAX_COUNT),
                governorate = d.governorate, city = d.city, editingPlace = d.governorate.isBlank() || d.city.isBlank(),
                priority = Priority.entries.firstOrNull { it.value == d.priority } ?: Priority.normal,
                sensitivity = SensitivityAnswers(
                    gate = when (d.gate) { "no" -> SensitivityGate.NO; "yes" -> SensitivityGate.YES; else -> null },
                    minors = d.minors, injured = d.injured, graphic = d.graphic,
                ),
                displayMode = DisplayName.Mode.entries.firstOrNull { it.value == d.displayMode } ?: DisplayName.Mode.real_name, pseudonym = d.pseudonym,
                values = d.values, originals = PickedFiles.stampKeys(d.files, materialIdempotencyKey, IdempotencyKey::generate),
            )
        }
        savedUris = d.files.map { it.uri }.toSet()
        _state.value.originals.forEach { describe(it) }
    }

    /** The current form; on failure the last one saved on the phone, marked as such (sending with no network). */
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

    private fun edit(block: SendUiState.() -> SendUiState) = _state.update { it.block().copy(error = null, draftSaved = false, dirty = true) }

    fun setTitle(v: String) = edit { copy(title = v) }
    fun toggleType(t: MaterialType) = edit { copy(types = if (t in types) types - t else types + t) }
    fun toggleUrgent() = edit { copy(priority = if (priority == Priority.urgent) Priority.normal else Priority.urgent) }
    fun toggleImportant() = edit { copy(priority = if (priority == Priority.important) Priority.normal else Priority.important) }
    fun editPlace() = _state.update { it.copy(editingPlace = true) }
    fun setGovernorate(v: String) = edit { copy(governorate = v) }
    fun setCity(v: String) = edit { copy(city = v) }
    fun answerGate(yes: Boolean) = edit { copy(sensitivity = sensitivity.answer(if (yes) SensitivityGate.YES else SensitivityGate.NO)) }
    fun answerFollowup(q: SensitivityAnswers.Question, v: Boolean) = edit { copy(sensitivity = sensitivity.answer(q, v)) }
    fun setDisplayMode(m: DisplayName.Mode) = edit { copy(displayMode = m) }
    fun setPseudonym(v: String) = edit { copy(pseudonym = v) }
    fun toggleMore() = _state.update { it.copy(moreOpen = !it.moreOpen) }
    fun openMore() = _state.update { it.copy(moreOpen = true) }
    fun setValue(key: String, value: Any?) = edit { copy(values = values + (key to value)) }
    fun setPicked(key: String, files: List<PickedFile>) = _state.update { it.copy(picked = it.picked + (key to files), dirty = true) }

    /** Typing in the tag field: what comes before a comma (Latin or Arabic) or a new line becomes tags; the rest stays typed. */
    fun tagText(text: String) {
        val (complete, rest) = MaterialTagRules.split(text)
        if (complete.isEmpty()) { edit { copy(tagText = text, tagError = null) }; return }
        val tags = _state.value.tags.toMutableList()
        var error: TagError? = null
        for (c in complete) error = errorOf(MaterialTagRules.add(c, tags)) ?: error
        edit { copy(tags = tags, tagText = rest, tagError = error) }
    }

    /** «Done» or leaving the field: the typed tag is added when it can be, else it stays with its reason. */
    fun commitTag() {
        val s = _state.value
        if (s.tagText.isBlank()) { _state.update { it.copy(tagText = "", tagError = null) }; return }
        val tags = s.tags.toMutableList()
        when (val r = MaterialTagRules.add(s.tagText, tags)) {
            is MaterialTagRules.AddResult.Added, MaterialTagRules.AddResult.Empty, MaterialTagRules.AddResult.Duplicate ->
                edit { copy(tags = tags, tagText = "", tagError = errorOf(r)) }
            else -> edit { copy(tagError = errorOf(r)) }
        }
    }

    fun removeTag(tag: String) = edit { copy(tags = tags - tag, tagError = null) }

    fun addSuggestion(tag: String) {
        val tags = _state.value.tags.toMutableList()
        val r = MaterialTagRules.add(tag, tags)
        edit { copy(tags = tags, tagError = errorOf(r)) }
    }

    private fun errorOf(r: MaterialTagRules.AddResult): TagError? = when (r) {
        MaterialTagRules.AddResult.TooLong -> TagError.TOO_LONG
        MaterialTagRules.AddResult.LimitReached -> TagError.LIMIT
        MaterialTagRules.AddResult.Duplicate -> TagError.DUPLICATE
        else -> null
    }

    /**
     * More files for the same send: appended in the order picked, nothing dropped silently. Duplicates and files beyond the
     * limit are filtered first, so a read grant is only taken for a file that enters.
     */
    fun addUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val selection = PickedFiles.select(_state.value.originals, uris.map { it.toString() })
            val accepted = withContext(Dispatchers.IO) { uris.filter { it.toString() in selection.accepted }.distinctBy { it.toString() }.map { describeUri(it) } }
            val result = PickedFiles.add(_state.value.originals, accepted)
            _state.update { it.copy(originals = result.files, skippedDuplicates = selection.duplicates, skippedOverLimit = selection.overLimit, draftSaved = false, dirty = it.dirty || result.added > 0, error = null) }
            accepted.forEach { describe(it) }
        }
    }

    /** Drops one file from the send. The file on the phone and the upload queue are untouched; its read grant is let go. */
    fun removeFile(uri: String) {
        _state.update { it.copy(originals = PickedFiles.remove(it.originals, uri), details = it.details - uri, skippedDuplicates = 0, skippedOverLimit = 0, draftSaved = false, dirty = true) }
        releaseUnsaved(uri)
    }

    /** Leaving with «discard»: the grants taken for this visit's files are let go, except those a saved draft still holds. */
    fun discard() {
        _state.value.originals.forEach { releaseUnsaved(it.uri) }
        screenFix = null
    }

    /** Name, size, type and filming time of a picked file, and its persistent read grant (the transfer outlives this screen). */
    private fun describeUri(uri: Uri): PickedOriginal {
        try { app.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (e: SecurityException) { /* provider does not persist grants */ }
        var name = "original"
        var size = 0L
        app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { i -> if (!c.isNull(i)) size = c.getLong(i) }
            }
        }
        val mime = app.contentResolver.getType(uri)
        // The key that creates this file's material, fixed now so every retry (and a saved draft) replays the same request.
        return PickedOriginal(uri.toString(), name, size, mime, materialKey = IdempotencyKey.generate(), capturedAtEpochMs = captureTime(uri, mime))
    }

    /** `shot_at` from the file: EXIF `DateTimeOriginal` for a photo, the container date for a video. Nothing else is read. */
    private fun captureTime(uri: Uri, mime: String?): Long? = runCatching {
        if (mime?.startsWith("video/") == true) {
            MediaMetadataRetriever().run { try { setDataSource(app, uri); CaptureDate.video(extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)) } finally { release() } }
        } else app.contentResolver.openInputStream(uri)?.use { input ->
            val exif = ExifInterface(input)
            CaptureDate.exif(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL), exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL))
        }
    }.getOrNull()

    private fun releaseUnsaved(uri: String) {
        if (uri in savedUris) return
        viewModelScope.launch { UriGrants.releaseIfUnused(app, container.database, uri) }
    }

    /** Thumbnail and duration for the file tile, read by the system without copying the file. */
    private fun describe(o: PickedOriginal) = viewModelScope.launch(Dispatchers.IO) {
        val uri = Uri.parse(o.uri)
        val thumb = runCatching { app.contentResolver.loadThumbnail(uri, Size(240, 320), null).asImageBitmap() }.getOrNull()
        val duration = if (o.isVideo) runCatching {
            MediaMetadataRetriever().run { try { setDataSource(app, uri); extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() } finally { release() } }
        }.getOrNull() else null
        _state.update { if (it.originals.any { f -> f.uri == o.uri }) it.copy(details = it.details + (o.uri to FileDetail(thumb, duration))) else it }
    }

    /** Keeps the draft on the phone only, on the home screen until sent. [onSaved] runs once it is written (leaving the screen). */
    fun saveDraft(onSaved: () -> Unit = {}) = viewModelScope.launch {
        writeDraft(sealedGps = draftFix)
        onSaved()
    }

    /** Writes the current state as the draft: the files still to send only, each with its key and its material id if created. */
    private suspend fun writeDraft(sealedGps: GpsFix?) {
        val s = _state.value
        val attachmentKeys = s.form?.fields?.filter { it.type == UploadFormField.Type.attachment }?.map { it.key }?.toSet().orEmpty()
        val d = MaterialDraft(
            title = s.title, types = s.types.map { it.value }, governorate = s.governorate, city = s.city, priority = s.priority.value,
            minors = s.sensitivity.minors, injured = s.sensitivity.injured, graphic = s.sensitivity.graphic,
            displayMode = s.displayMode.value, pseudonym = s.pseudonym, values = s.values.filterKeys { it !in attachmentKeys }, files = s.originals,
            tags = s.tags, gate = when (s.sensitivity.gate) { SensitivityGate.NO -> "no"; SensitivityGate.YES -> "yes"; null -> null },
        )
        val sealed = sealedGps?.let { runCatching { container.sealer.sealString(it.encode()) }.getOrNull() }
        container.database.drafts().upsert(DraftEntity(id, s.title, d.toJson(), System.currentTimeMillis(), sealedGps = sealed))
        val held = s.originals.map { it.uri }.toSet()
        val dropped = savedUris - held
        savedUris = held
        // Files the previous save held and this one does not (removed, or already queued) lose their grant unless something else uses them.
        for (u in dropped) UriGrants.releaseIfUnused(app, container.database, u)
        _state.update { it.copy(draftSaved = true, dirty = false) }
    }

    fun submit() {
        val before = _state.value
        if (before.submitting) return
        // A typed tag the reporter did not commit (tapping «Send» keeps the field's focus) counts as added when it can be.
        if (before.tagText.isNotBlank()) {
            val tags = before.tags.toMutableList()
            if (!MaterialTagRules.commitPending(before.tagText, tags)) return
            _state.update { it.copy(tags = tags, tagText = "") }
        }
        val s = _state.value
        if (s.reason != null || s.form == null) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val now = System.currentTimeMillis()
            val gps = draftFix ?: GpsPolicy.usable(GpsPolicy.fresher(screenFix, location.current()), now)
            submitBatch(_state.value, gps, now)
        }
    }

    /**
     * One material per file (the server keeps one original per material), all with the details typed once. The send enters the
     * ledger before the first request; each file's material joins it before its row is queued; the loop closes it with what was
     * queued. Keys and row ids are stable, so nothing is created or queued twice; on a failure the files still to send stay as
     * the draft, with the send's location sealed beside them.
     */
    private suspend fun submitBatch(s: SendUiState, gps: GpsFix?, now: Long) {
        val form = s.form!!
        val visibleKeys = FormValidator.visibleFields(form, s.primaryType, s.values).map { it.key }.toSet()
        val files = PickedFiles.assignPositions(PickedFiles.stampKeys(s.originals, materialIdempotencyKey, IdempotencyKey::generate))
        _state.update { it.copy(originals = files) }
        val title = s.title.trim()
        fun titleOf(f: PickedOriginal) = MaterialTitles.titleFor(title, f.position!!, f.total!!)
        val ledger = container.sendBatches
        val owner = container.scope.value.current
        val batch = ledger.begin(title, files.map { it.materialKey!! }, s.sensitivity.sensitive, owner = owner, nowMs = now)
        val queued = ArrayList<String>()
        val point = gps?.let { GpsPoint(BigDecimal.valueOf(it.lat), BigDecimal.valueOf(it.lng), it.accuracyM?.let(BigDecimal::valueOf)) }
        val result = MaterialBatch.run(
            files,
            createMaterial = { f ->
                container.materialsApi.createMaterial(
                    f.materialKey!!,
                    MaterialCreate(
                        title = titleOf(f), materialTypes = s.types, governorate = s.governorate.trim(), city = s.city.trim(),
                        priority = s.priority,
                        sensitivity = Sensitivity(minors = s.sensitivity.minors!!, injured = s.sensitivity.injured!!, graphic = s.sensitivity.graphic!!),
                        displayName = DisplayName(mode = s.displayMode, pseudonym = s.pseudonym.trim().takeIf { s.displayMode == DisplayName.Mode.pseudonym }),
                        formVersion = form.version,
                        dynamicFields = s.values.filterKeys { it in visibleKeys }.filterValues { it != null }.mapValues { it.value as Any },
                        shotAt = f.capturedAtEpochMs?.let { OffsetDateTime.ofInstant(Instant.ofEpochMilli(it), ZoneOffset.UTC) },
                        gps = point,
                        tags = s.tags.toSet().takeIf { it.isNotEmpty() },
                    ),
                ).id.toString()
            },
            enqueue = { f, materialId ->
                ledger.add(materialId, batch.id)
                val task = UploadTask(
                    id = UploadIds.taskId(materialId), materialId = materialId, kind = "original",
                    fileUri = f.uri, filename = f.name, mimeType = f.mimeType, sizeBytes = f.sizeBytes,
                    idempotencyKey = UploadIds.sessionKey(materialId), createdAtEpochMs = now + f.position!!, // the queue runs oldest first
                    ownerAccount = owner, // ADR 0093: the signed-in account's opaque local id, never its email or server id
                )
                container.uploadStore.insert(task, title = titleOf(f), priority = s.priority.value)
                queued.add(materialId)
                task.id
            },
            persist = { rest ->
                _state.update { st -> st.copy(originals = rest, details = st.details.filterKeys { k -> rest.any { it.uri == k } }) }
                // Written at every step so a killed process loses nothing and the repeat skips what was done; the last step
                // writes nothing: the draft (and the location sealed in it) goes when the send ends.
                if (rest.isNotEmpty()) writeDraft(sealedGps = gps)
            },
        )
        ledger.finish(batch.id, queued)
        val queuedBytes = files.filter { f -> result.remaining.none { it.uri == f.uri } }.sumOf { it.sizeBytes.coerceAtLeast(0) }
        if (queued.isNotEmpty()) {
            UploadScheduler.start(app, queuedBytes)
            withContext(Dispatchers.IO) { container.reporterMemory.update { it.rememberSend(s.governorate, s.city, s.tags) } }
        }
        val failure = result.failure
        if (failure == null) {
            container.database.drafts().delete(id)
            draftFix = null
            screenFix = null
            container.receipts.afterSend(batch.id)
            _state.update { it.copy(submitting = false, dirty = false, sentBatchId = batch.id) }
        } else {
            // The draft already holds what is left (the failed file with its material id if it has one, and the rest).
            val note = if (queued.isNotEmpty()) "\n" + app.getString(R.string.a1_partial_failed, queued.size, files.size, result.remaining.size) else ""
            _state.update { it.copy(submitting = false, error = describeFailure(app, failure) + note) }
        }
    }
}
