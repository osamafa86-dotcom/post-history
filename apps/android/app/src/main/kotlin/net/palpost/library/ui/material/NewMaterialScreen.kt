package net.palpost.library.ui.material

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.DisplayName
import net.palpost.library.api.models.MaterialCreate
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.api.models.Sensitivity
import net.palpost.library.api.models.UploadForm
import net.palpost.library.core.forms.FormValidator
import net.palpost.library.core.forms.ValidationResult
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.core.upload.UploadTask
import net.palpost.library.ui.describeFailure
import net.palpost.library.ui.forms.DynamicForm
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.forms.PickedFile
import net.palpost.library.ui.forms.materialTypeLabel
import net.palpost.library.upload.UploadScheduler
import java.util.UUID

/** The file the reporter picked for the original: kept as a persistable content URI, never copied. */
data class PickedOriginal(val uri: Uri, val name: String, val sizeBytes: Long, val mimeType: String?)

data class NewMaterialUiState(
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
    val formError: String? = null,
    val values: Map<String, Any?> = emptyMap(),
    val picked: Map<String, List<PickedFile>> = emptyMap(),
    val original: PickedOriginal? = null,
    val showErrors: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
    val createdTaskId: String? = null,
) {
    val primaryType: MaterialType get() = types.firstOrNull() ?: MaterialType.report
    val dynamicResult: ValidationResult? get() = form?.let { FormValidator.validate(it, primaryType, values) }
    val titleError: Boolean get() = title.codePointCount(0, title.length) !in 5..80
    val sensitivityMissing: Boolean get() = minors == null || injured == null || graphic == null
    val pseudonymMissing: Boolean get() = displayMode == DisplayName.Mode.pseudonym && pseudonym.isBlank()
    val fixedValid: Boolean get() = !titleError && types.isNotEmpty() && governorate.isNotBlank() && city.isNotBlank() && !sensitivityMissing && !pseudonymMissing && original != null
    val canSubmit: Boolean get() = fixedValid && (dynamicResult?.valid == true) && !submitting
}

class NewMaterialViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(NewMaterialUiState())
    val state: StateFlow<NewMaterialUiState> = _state
    /** One key per draft: a retry of the same material after a network error replays, it does not duplicate. */
    private val materialIdempotencyKey = IdempotencyKey.generate()

    init { loadForm() }

    fun loadForm() {
        _state.update { it.copy(formError = null) }
        viewModelScope.launch {
            try {
                _state.update { it.copy(form = container.formsApi.getCurrentForm(null)) }
            } catch (t: Throwable) {
                _state.update { it.copy(formError = describeFailure(app, t)) }
            }
        }
    }

    fun update(block: NewMaterialUiState.() -> NewMaterialUiState) = _state.update { it.block().copy(error = null) }
    fun setValue(key: String, value: Any?) = _state.update { it.copy(values = it.values + (key to value)) }
    fun setPicked(key: String, files: List<PickedFile>) = _state.update { it.copy(picked = it.picked + (key to files)) }

    fun submit() {
        val s = _state.value
        if (!s.fixedValid || s.dynamicResult?.valid != true) { _state.update { it.copy(showErrors = true) }; return }
        if (s.submitting) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            try {
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
                val original = s.original!!
                val task = UploadTask(
                    id = UUID.randomUUID().toString(), materialId = material.id.toString(), kind = "original",
                    fileUri = original.uri.toString(), filename = original.name, mimeType = original.mimeType, sizeBytes = original.sizeBytes,
                    idempotencyKey = IdempotencyKey.generate(), createdAtEpochMs = System.currentTimeMillis(),
                )
                container.uploadStore.insert(task, title = s.title)
                UploadScheduler.start(app, original.sizeBytes)
                _state.update { it.copy(submitting = false, createdTaskId = task.id) }
            } catch (t: Throwable) {
                _state.update { it.copy(submitting = false, error = describeFailure(app, t)) }
            }
        }
    }
}

@Composable
fun NewMaterialScreen(container: AppContainer, onBack: () -> Unit, onQueued: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    val vm: NewMaterialViewModel = viewModel(factory = viewModelFactory { initializer { NewMaterialViewModel(app, container) } })
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
        vm.update { copy(original = PickedOriginal(uri, name, size, context.contentResolver.getType(uri))) }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.material_new_title)) }, navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } }) }) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp, vertical = 12.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // The original file: picked first, uploaded last, never compressed.
            Text(stringResource(R.string.material_file_section), style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }) { Text(stringResource(R.string.material_pick_file)) }
                Text(s.original?.let { stringResource(R.string.material_file_chosen, FieldInput.describeBytes(it.sizeBytes)) } ?: stringResource(R.string.material_file_none), style = MaterialTheme.typography.bodyMedium)
            }
            if (s.showErrors && s.original == null) Text(stringResource(R.string.material_file_required), color = MaterialTheme.colorScheme.error)

            HorizontalDivider()
            OutlinedTextField(
                value = s.title, onValueChange = { v -> vm.update { copy(title = v) } }, label = { Text(stringResource(R.string.material_title) + " *") },
                isError = s.showErrors && s.titleError, supportingText = { Text(stringResource(R.string.material_title_help)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Text(stringResource(R.string.material_types) + " *", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    MaterialType.entries.chunked(3).forEach { rowTypes ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (t in rowTypes) {
                                val on = t in s.types
                                FilterChip(selected = on, onClick = { vm.update { copy(types = if (on) types - t else types + t) } }, label = { Text(materialTypeLabel(t)) })
                            }
                        }
                    }
                }
            }
            if (s.showErrors && s.types.isEmpty()) Text(stringResource(R.string.field_err_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(value = s.governorate, onValueChange = { v -> vm.update { copy(governorate = v) } }, label = { Text(stringResource(R.string.material_governorate) + " *") }, isError = s.showErrors && s.governorate.isBlank(), singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = s.city, onValueChange = { v -> vm.update { copy(city = v) } }, label = { Text(stringResource(R.string.material_city) + " *") }, isError = s.showErrors && s.city.isBlank(), singleLine = true, modifier = Modifier.fillMaxWidth())

            Text(stringResource(R.string.material_priority) + " *", style = MaterialTheme.typography.labelLarge)
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                Priority.entries.forEachIndexed { i, p ->
                    SegmentedButton(selected = s.priority == p, onClick = { vm.update { copy(priority = p) } }, shape = SegmentedButtonDefaults.itemShape(i, Priority.entries.size)) { Text(priorityLabel(p)) }
                }
            }

            Text(stringResource(R.string.material_sensitivity) + " *", style = MaterialTheme.typography.labelLarge)
            Text(stringResource(R.string.material_sensitivity_help), style = MaterialTheme.typography.bodySmall)
            YesNo(stringResource(R.string.material_sensitivity_minors), s.minors) { v -> vm.update { copy(minors = v) } }
            YesNo(stringResource(R.string.material_sensitivity_injured), s.injured) { v -> vm.update { copy(injured = v) } }
            YesNo(stringResource(R.string.material_sensitivity_graphic), s.graphic) { v -> vm.update { copy(graphic = v) } }
            if (s.showErrors && s.sensitivityMissing) Text(stringResource(R.string.material_sensitivity_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)

            DisplayModePicker(s.displayMode) { m -> vm.update { copy(displayMode = m) } }
            if (s.displayMode == DisplayName.Mode.pseudonym) {
                OutlinedTextField(value = s.pseudonym, onValueChange = { v -> vm.update { copy(pseudonym = v) } }, label = { Text(stringResource(R.string.material_pseudonym) + " *") }, isError = s.showErrors && s.pseudonymMissing, singleLine = true, modifier = Modifier.fillMaxWidth())
            }

            HorizontalDivider()
            when {
                s.form != null -> {
                    Text(stringResource(R.string.form_title) + " · " + stringResource(R.string.form_version, s.form!!.version), style = MaterialTheme.typography.titleMedium)
                    DynamicForm(s.form!!, s.primaryType, s.values, if (s.showErrors) s.dynamicResult else null, s.picked, vm::setValue, vm::setPicked)
                }
                s.formError != null -> {
                    Text(s.formError!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = vm::loadForm) { Text(stringResource(R.string.action_retry)) }
                }
                else -> Text(stringResource(R.string.home_loading))
            }

            s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = vm::submit, enabled = !s.submitting && s.form != null, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(if (s.submitting) R.string.material_submitting else R.string.material_submit))
            }
            Text(stringResource(R.string.material_submit_help), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun YesNo(label: String, value: Boolean?, onChange: (Boolean) -> Unit) {
    Text(label, style = MaterialTheme.typography.bodyMedium)
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        SegmentedButton(selected = value == true, onClick = { onChange(true) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.form_bool_yes)) }
        SegmentedButton(selected = value == false, onClick = { onChange(false) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.form_bool_no)) }
    }
}

@Composable
private fun DisplayModePicker(current: DisplayName.Mode, onPick: (DisplayName.Mode) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = displayModeLabel(current), onValueChange = {}, readOnly = true, label = { Text(stringResource(R.string.material_display_name)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (m in DisplayName.Mode.entries) DropdownMenuItem(text = { Text(displayModeLabel(m)) }, onClick = { onPick(m); expanded = false })
        }
    }
}

@Composable
fun priorityLabel(p: Priority): String = stringResource(when (p) { Priority.urgent -> R.string.priority_urgent; Priority.important -> R.string.priority_important; Priority.normal -> R.string.priority_normal })

@Composable
fun displayModeLabel(m: DisplayName.Mode): String = stringResource(when (m) { DisplayName.Mode.real_name -> R.string.display_real_name; DisplayName.Mode.pseudonym -> R.string.display_pseudonym; DisplayName.Mode.network -> R.string.display_network })
