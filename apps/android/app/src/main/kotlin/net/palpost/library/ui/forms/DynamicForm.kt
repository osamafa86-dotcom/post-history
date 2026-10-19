package net.palpost.library.ui.forms

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import net.palpost.library.R
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.UploadForm
import net.palpost.library.api.models.UploadFormField
import net.palpost.library.core.forms.AttachmentValue
import net.palpost.library.core.forms.ErrorCode
import net.palpost.library.core.forms.FormValidator
import net.palpost.library.core.forms.ValidationResult

/** A file the reporter picked for an attachment field: what the validator sees plus where it is. */
data class PickedFile(val uri: Uri, val name: String, val value: AttachmentValue)

/**
 * Renders a form version field by field, in form order, showing only what [FormValidator.visibleFields]
 * says is visible for this material type and these values. Values are the JSON shapes the validator checks.
 */
@Composable
fun DynamicForm(
    form: UploadForm,
    materialType: MaterialType,
    values: Map<String, Any?>,
    errors: ValidationResult?,
    picked: Map<String, List<PickedFile>>,
    onValueChange: (key: String, value: Any?) -> Unit,
    onFilesPicked: (key: String, files: List<PickedFile>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for (field in FormValidator.visibleFields(form, materialType, values)) {
            FieldRow(field, values[field.key], errors?.errorFor(field.key), picked[field.key].orEmpty(), onValueChange, onFilesPicked)
        }
    }
}

@Composable
private fun FieldRow(
    field: UploadFormField,
    value: Any?,
    errorCode: String?,
    picked: List<PickedFile>,
    onValueChange: (String, Any?) -> Unit,
    onFilesPicked: (String, List<PickedFile>) -> Unit,
) {
    val label = field.label.localized() + if (field.required) " " + stringResource(R.string.form_required_mark) else ""
    val errorText = errorCode?.let { fieldErrorText(it, field) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when (field.type) {
            UploadFormField.Type.short_text -> TextInput(label, value, errorText, singleLine = true) { onValueChange(field.key, FieldInput.textValue(it)) }
            UploadFormField.Type.long_text -> TextInput(label, value, errorText, singleLine = false) { onValueChange(field.key, FieldInput.textValue(it)) }
            UploadFormField.Type.number -> NumberInput(label, value, errorText) { onValueChange(field.key, it) }
            UploadFormField.Type.select -> SelectInput(label, field, value, errorText) { onValueChange(field.key, it) }
            UploadFormField.Type.multi_select -> MultiSelectInput(label, field, value, errorText) { onValueChange(field.key, it) }
            UploadFormField.Type.datetime -> DateTimeInput(label, value, errorText) { onValueChange(field.key, it) }
            UploadFormField.Type.boolean -> BooleanInput(label, value, errorText) { onValueChange(field.key, it) }
            UploadFormField.Type.staff_member -> TextInput(label, value, errorText, singleLine = true, placeholder = stringResource(R.string.form_staff_member_hint)) { onValueChange(field.key, FieldInput.textValue(it)) }
            UploadFormField.Type.attachment -> AttachmentInput(label, field, picked, errorText) { files -> onFilesPicked(field.key, files); onValueChange(field.key, files.map { it.value.toMap() }) }
            UploadFormField.Type.location -> Text(stringResource(R.string.form_location_unsupported), color = MaterialTheme.colorScheme.error)
        }
        field.help?.let { Text(it.localized(), style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun TextInput(label: String, value: Any?, errorText: String?, singleLine: Boolean, placeholder: String? = null, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value as? String ?: "", onValueChange = onChange, label = { Text(label) }, singleLine = singleLine,
        minLines = if (singleLine) 1 else 3, isError = errorText != null, supportingText = errorText?.let { { Text(it) } },
        placeholder = placeholder?.let { { Text(it) } }, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun NumberInput(label: String, value: Any?, errorText: String?, onChange: (Any?) -> Unit) {
    var text by rememberSaveable(value == null) { mutableStateOf(value?.let { if (it is Double && it == Math.floor(it) && !it.isInfinite()) it.toLong().toString() else it.toString() } ?: "") }
    OutlinedTextField(
        value = text, onValueChange = { text = it; onChange(FieldInput.numberValue(it)) }, label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), isError = errorText != null,
        supportingText = errorText?.let { { Text(it) } }, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SelectInput(label: String, field: UploadFormField, value: Any?, errorText: String?, onChange: (Any?) -> Unit) {
    val options = field.validation?.options.orEmpty()
    var expanded by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.value == value }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = current?.label?.localized() ?: (value as? String ?: ""), onValueChange = {}, readOnly = true, label = { Text(label) },
            placeholder = { Text(stringResource(R.string.form_select_placeholder)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) }, isError = errorText != null,
            supportingText = errorText?.let { { Text(it) } },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (o in options) DropdownMenuItem(text = { Text(o.label.localized()) }, onClick = { onChange(o.value); expanded = false })
        }
    }
}

@Composable
private fun MultiSelectInput(label: String, field: UploadFormField, value: Any?, errorText: String?, onChange: (Any?) -> Unit) {
    val selected = (value as? List<*>)?.filterIsInstance<String>().orEmpty()
    Text(label, style = MaterialTheme.typography.labelLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (o in field.validation?.options.orEmpty()) {
            val on = o.value in selected
            FilterChip(selected = on, onClick = { onChange(if (on) selected - o.value else selected + o.value) }, label = { Text(o.label.localized()) })
        }
    }
    errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun DateTimeInput(label: String, value: Any?, errorText: String?, onChange: (Any?) -> Unit) {
    OutlinedTextField(
        value = value as? String ?: "", onValueChange = { onChange(FieldInput.textValue(it)) }, label = { Text(label) }, singleLine = true,
        placeholder = { Text(stringResource(R.string.form_datetime_hint)) }, isError = errorText != null,
        supportingText = errorText?.let { { Text(it) } },
        trailingIcon = { TextButton(onClick = { onChange(FieldInput.nowRfc3339()) }) { Text(stringResource(R.string.form_datetime_now)) } },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun BooleanInput(label: String, value: Any?, errorText: String?, onChange: (Any?) -> Unit) {
    Text(label, style = MaterialTheme.typography.labelLarge)
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        SegmentedButton(selected = value == true, onClick = { onChange(true) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.form_bool_yes)) }
        SegmentedButton(selected = value == false, onClick = { onChange(false) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.form_bool_no)) }
    }
    errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun AttachmentInput(label: String, field: UploadFormField, picked: List<PickedFile>, errorText: String?, onPicked: (List<PickedFile>) -> Unit) {
    val context = LocalContext.current
    val accept = field.validation?.accept.orEmpty().ifEmpty { listOf("*/*") }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val resolver = context.contentResolver
        onPicked(
            uris.map { uri ->
                var name = uri.lastPathSegment ?: "file"
                var size = 0L
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                        c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { i -> if (!c.isNull(i)) size = c.getLong(i) }
                    }
                }
                PickedFile(uri, name, AttachmentValue(resolver.getType(uri) ?: "application/octet-stream", size))
            },
        )
    }
    Text(label, style = MaterialTheme.typography.labelLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = { launcher.launch(accept.toTypedArray()) }) { Text(stringResource(R.string.form_attachment_pick)) }
        Text(if (picked.isEmpty()) stringResource(R.string.form_attachment_none) else stringResource(R.string.form_attachment_count, picked.size), style = MaterialTheme.typography.bodyMedium)
    }
    errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

/** Text for a shared-vocabulary error code, with the limit that was crossed. */
@Composable
fun fieldErrorText(code: String, field: UploadFormField): String {
    val v = field.validation
    return when (code) {
        ErrorCode.REQUIRED -> stringResource(R.string.field_err_required)
        ErrorCode.TYPE -> stringResource(R.string.field_err_type)
        ErrorCode.MIN_LENGTH -> stringResource(R.string.field_err_min_length, v?.minLength ?: 0L)
        ErrorCode.MAX_LENGTH -> stringResource(R.string.field_err_max_length, v?.maxLength ?: 0L)
        ErrorCode.PATTERN -> stringResource(R.string.field_err_pattern)
        ErrorCode.MIN -> stringResource(R.string.field_err_min, v?.min?.toPlainString() ?: "")
        ErrorCode.MAX -> stringResource(R.string.field_err_max, v?.max?.toPlainString() ?: "")
        ErrorCode.OPTION -> stringResource(R.string.field_err_option)
        ErrorCode.MIN_ITEMS -> stringResource(R.string.field_err_min_items, v?.minItems ?: 0L)
        ErrorCode.MAX_ITEMS -> stringResource(R.string.field_err_max_items, v?.maxItems ?: 0L)
        ErrorCode.NOT_BEFORE -> stringResource(R.string.field_err_not_before, v?.notBefore?.let { FieldInput.formatRfc3339(it) } ?: "")
        ErrorCode.NOT_AFTER -> stringResource(R.string.field_err_not_after, v?.notAfter?.let { FieldInput.formatRfc3339(it) } ?: "")
        ErrorCode.ACCEPT -> stringResource(R.string.field_err_accept)
        ErrorCode.MAX_SIZE_BYTES -> stringResource(R.string.field_err_max_size_bytes, v?.maxSizeBytes?.let { FieldInput.describeBytes(it) } ?: "")
        else -> stringResource(R.string.field_err_type)
    }
}
