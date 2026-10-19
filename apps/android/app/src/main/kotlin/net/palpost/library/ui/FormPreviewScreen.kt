package net.palpost.library.ui

import android.app.Application
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import net.palpost.library.core.forms.FormValidator
import net.palpost.library.core.forms.ValidationResult
import net.palpost.library.ui.forms.DynamicForm
import net.palpost.library.ui.forms.PickedFile
import net.palpost.library.ui.forms.materialTypeLabel

data class FormPreviewUiState(
    val materialType: MaterialType = MaterialType.report,
    val form: UploadForm? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val values: Map<String, Any?> = emptyMap(),
    val picked: Map<String, List<PickedFile>> = emptyMap(),
    /** Null until the reporter asks for validation; afterwards kept live on every change. */
    val result: ValidationResult? = null,
)

class FormPreviewViewModel(private val app: Application, private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(FormPreviewUiState())
    val state: StateFlow<FormPreviewUiState> = _state

    init { load(MaterialType.report) }

    fun load(type: MaterialType) {
        _state.update { it.copy(materialType = type, loading = true, error = null, result = null) }
        viewModelScope.launch {
            try {
                // The full version is fetched (no material_type filter) so the renderer itself decides visibility,
                // exactly as it will for drafts saved with an older version.
                val form = container.formsApi.getCurrentForm(null)
                _state.update { it.copy(form = form, loading = false) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = describeFailure(app, t)) }
            }
        }
    }

    fun setValue(key: String, value: Any?) = _state.update { s ->
        val values = s.values + (key to value)
        s.copy(values = values, result = s.result?.let { revalidate(s, values) })
    }

    fun setPicked(key: String, files: List<PickedFile>) = _state.update { it.copy(picked = it.picked + (key to files)) }

    fun validate() = _state.update { it.copy(result = revalidate(it, it.values)) }

    private fun revalidate(s: FormPreviewUiState, values: Map<String, Any?>): ValidationResult? =
        s.form?.let { FormValidator.validate(it, s.materialType, values) }
}

@Composable
fun FormPreviewScreen(container: AppContainer, onBack: () -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    val vm: FormPreviewViewModel = viewModel(factory = viewModelFactory { initializer { FormPreviewViewModel(app, container) } })
    val s by vm.state.collectAsStateWithLifecycle()
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(s.form?.let { stringResource(R.string.form_title) + " · " + stringResource(R.string.form_version, it.version) } ?: stringResource(R.string.form_title)) },
            navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
        )
    }) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp, vertical = 12.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            MaterialTypePicker(s.materialType) { vm.load(it) }
            when {
                s.loading -> Text(stringResource(R.string.home_loading))
                s.error != null -> {
                    Text(s.error!!, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = { vm.load(s.materialType) }) { Text(stringResource(R.string.action_retry)) }
                }
                s.form != null -> {
                    DynamicForm(s.form!!, s.materialType, s.values, s.result, s.picked, vm::setValue, vm::setPicked)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                        Button(onClick = vm::validate) { Text(stringResource(R.string.form_validate)) }
                        s.result?.let { r ->
                            Text(
                                if (r.valid) stringResource(R.string.form_valid) else stringResource(R.string.form_invalid, r.errors.size),
                                color = if (r.valid) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MaterialTypePicker(current: MaterialType, onPick: (MaterialType) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = materialTypeLabel(current), onValueChange = {}, readOnly = true, label = { Text(stringResource(R.string.form_material_type)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (t in MaterialType.entries) DropdownMenuItem(text = { Text(materialTypeLabel(t)) }, onClick = { onPick(t); expanded = false })
        }
    }
}
