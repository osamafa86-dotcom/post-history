package net.palpost.library.ui.send

import android.app.Application
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.DisplayName
import net.palpost.library.api.models.MaterialType
import net.palpost.library.api.models.Priority
import net.palpost.library.core.forms.ValidationResult
import net.palpost.library.core.send.SendReadiness.Reason
import net.palpost.library.core.send.SensitivityAnswers
import net.palpost.library.core.send.SensitivityGate
import net.palpost.library.ui.forms.DynamicForm
import net.palpost.library.ui.forms.FieldInput
import net.palpost.library.ui.forms.materialTypeLabel
import net.palpost.library.ui.material.MaterialTitles
import net.palpost.library.ui.material.PickedFiles
import net.palpost.library.ui.theme.CoverageTypeChips
import net.palpost.library.ui.theme.EmptyState
import net.palpost.library.ui.theme.FieldLabel
import net.palpost.library.ui.theme.FileTile
import net.palpost.library.ui.theme.FilesStrip
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.InlineAlert
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.OutlineButton
import net.palpost.library.ui.theme.PlaceChip
import net.palpost.library.ui.theme.PrimaryButton
import net.palpost.library.ui.theme.SensitivityQuestion
import net.palpost.library.ui.theme.TagInput
import net.palpost.library.ui.theme.TitleField
import net.palpost.library.ui.theme.Tone
import net.palpost.library.ui.theme.UrgentToggle
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlChip
import net.palpost.library.ui.theme.VlIconButton
import net.palpost.library.ui.theme.ltr
import net.palpost.library.ui.theme.vlFieldColors
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import java.util.UUID

/** 04 · the one send screen: a full screen, never a sheet, so it cannot be dismissed by a gesture; back asks first. */
@Composable
fun SendScreen(container: AppContainer, draftId: String?, onClose: () -> Unit, onSent: (String) -> Unit) {
    val app = LocalContext.current.applicationContext as Application
    // A fresh view model per visit: leaving by «discard» (or after sending) must not bring the old input back on the next visit.
    val visit = rememberSaveable { UUID.randomUUID().toString() }
    val vm: SendViewModel = viewModel(key = "send-$draftId-$visit", factory = viewModelFactory { initializer { SendViewModel(app, container, draftId) } })
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(s.sentBatchId) { s.sentBatchId?.let(onSent) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PickedFiles.MAX)) { uris -> vm.addUris(uris) }
    val pick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }
    // A new send opens the gallery at once (ADR 0088); a draft opens with its files.
    var autoPicked by rememberSaveable { mutableStateOf(draftId != null) }
    LaunchedEffect(Unit) { if (!autoPicked) { autoPicked = true; pick() } }

    var confirmLeave by rememberSaveable { mutableStateOf(false) }
    val requestLeave: () -> Unit = { if (s.dirty) confirmLeave = true else onClose() }
    BackHandler(enabled = !s.submitting) { requestLeave() }
    if (confirmLeave) LeaveDialog(
        onSave = { confirmLeave = false; vm.saveDraft(onSaved = onClose) },
        onDiscard = { confirmLeave = false; vm.discard(); onClose() },
        onKeep = { confirmLeave = false },
    )

    val scroll = rememberScrollState()
    Scaffold(
        containerColor = Vl.colors.bgBase,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.send_title), style = Vl.text.headline) },
                navigationIcon = { VlIconButton(Icons.Outlined.Close, stringResource(R.string.send_close), requestLeave, modifier = Modifier.padding(horizontal = VlSpace.s2)) },
                actions = { GhostButton(stringResource(if (s.draftSaved) R.string.a1_draft_saved else R.string.a1_save_draft), { vm.saveDraft() }, enabled = !s.submitting) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Vl.colors.bgBase),
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = VlSpace.s5, vertical = VlSpace.s4), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
                s.error?.let { Text(it, style = Vl.text.caption, color = Vl.colors.stateDanger) }
                val reason = s.reason
                val label = when {
                    s.submitting -> stringResource(R.string.send_sending)
                    reason != null -> reasonText(reason)
                    else -> pluralStringResource(R.plurals.send_cta, s.originals.size, s.originals.size)
                }
                PrimaryButton(label, vm::submit, enabled = reason == null && !s.submitting)
            }
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(scroll).padding(horizontal = VlSpace.s5, vertical = VlSpace.s3),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s5),
        ) {
            Column(Modifier.widthIn(max = 600.dp).align(Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(VlSpace.s5)) {
                Files(s, pick, vm::removeFile)
                TitleField(
                    label = stringResource(R.string.send_field_title), value = s.title, onChange = vm::setTitle, count = s.titleLength, max = s.titleMax,
                    isError = s.title.isNotBlank() && (s.reason == Reason.TITLE || s.reason == Reason.TITLE_TOO_LONG_FOR_SET) && s.titleLength > s.titleMax,
                    help = if (s.batchSize > 1) stringResource(R.string.send_title_help_many, ltr(MaterialTitles.longestSuffix(s.batchSize).trim())) else null,
                )
                CoverageTypeChips(
                    groupLabel = stringResource(R.string.send_field_type), moreLabel = stringResource(R.string.send_type_more),
                    all = MaterialType.entries.toList(), selected = s.types, labelOf = { materialTypeLabel(it) }, onToggle = vm::toggleType,
                )
                TagInput(
                    label = stringResource(R.string.send_field_tags), placeholder = stringResource(R.string.send_tags_add), tags = s.tags, text = s.tagText,
                    onText = vm::tagText, onCommit = vm::commitTag, onRemove = vm::removeTag,
                    removeLabel = { stringResource(R.string.send_tags_remove, it) },
                    error = s.tagError?.let { tagErrorText(it) },
                    suggestionsLabel = stringResource(R.string.send_tags_history), suggestions = s.tagSuggestions, onSuggestion = vm::addSuggestion,
                )
                Place(s, vm)
                SensitivityQuestion(
                    question = stringResource(R.string.send_sensitivity_q),
                    gate = when (s.sensitivity.effectiveGate) { SensitivityGate.YES -> true; SensitivityGate.NO -> false; null -> null },
                    followups = if (s.sensitivity.followupsShown) SensitivityAnswers.Question.entries.map { q -> followupText(q) to s.sensitivity.valueOf(q) } else null,
                    yes = stringResource(R.string.form_bool_yes), no = stringResource(R.string.form_bool_no),
                    onGate = vm::answerGate, onFollowup = { i, v -> vm.answerFollowup(SensitivityAnswers.Question.entries[i], v) },
                )
                FormPart(s, vm, required = true)
                More(s, vm)
            }
        }
    }
    // When the office form becomes what stops the send, its first wrong field is under «More»: open it.
    LaunchedEffect(s.revealFormErrors, s.formCheck?.firstIsUnderMore) {
        if (s.revealFormErrors && s.formCheck?.firstIsUnderMore == true) vm.openMore()
    }
}

@Composable
private fun Files(s: SendUiState, pick: () -> Unit, remove: (String) -> Unit) {
    if (s.originals.isEmpty()) {
        EmptyState(Icons.Outlined.PhotoLibrary, stringResource(R.string.send_files_empty_title), stringResource(R.string.a1_files_help, PickedFiles.MAX)) {
            OutlineButton(stringResource(R.string.a1_pick_gallery_many), pick, small = true)
        }
        return
    }
    val count = s.originals.size
    FilesStrip(
        summary = pluralStringResource(R.plurals.send_files, count, count) + " · " + FieldInput.describeBytes(PickedFiles.totalBytes(s.originals)),
        tiles = s.originals.mapIndexed { i, o -> FileTile(o.uri, s.details[o.uri]?.thumbnail, o.isVideo, stringResource(R.string.send_remove_file, i + 1, count)) },
        addLabel = stringResource(R.string.a1_add_more), canAdd = PickedFiles.remaining(s.originals) > 0, onAdd = pick, onRemove = remove,
    )
    if (s.skippedOverLimit > 0) InlineAlert(Tone.ATTENTION, stringResource(R.string.a1_files_over_limit, PickedFiles.MAX, s.skippedOverLimit))
    if (s.skippedDuplicates > 0) InlineAlert(Tone.NEUTRAL, stringResource(R.string.a1_files_duplicates, s.skippedDuplicates))
    Text(stringResource(R.string.a1_original_as_is), style = Vl.text.caption, color = Vl.colors.textSecondary)
}

@Composable
private fun Place(s: SendUiState, vm: SendViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically) {
        val place = listOf(s.governorate.trim(), s.city.trim()).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { null }
        PlaceChip(
            place = place,
            note = stringResource(if (place == null) R.string.send_place_empty else if (s.placeRemembered) R.string.send_place_remembered else R.string.send_place_edit),
            editLabel = stringResource(R.string.send_place_edit),
            modifier = Modifier.weight(1f), onEdit = vm::editPlace,
        )
        UrgentToggle(stringResource(R.string.send_urgent), s.priority == Priority.urgent, vm::toggleUrgent)
    }
    if (s.editingPlace) Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        OutlinedTextField(
            value = s.governorate, onValueChange = vm::setGovernorate, label = { Text(stringResource(R.string.material_governorate)) }, singleLine = true,
            textStyle = Vl.text.body, colors = vlFieldColors(), shape = RoundedCornerShape(VlRadius.md), modifier = Modifier.weight(1f),
        )
        OutlinedTextField(
            value = s.city, onValueChange = vm::setCity, label = { Text(stringResource(R.string.material_city)) }, singleLine = true,
            textStyle = Vl.text.body, colors = vlFieldColors(), shape = RoundedCornerShape(VlRadius.md), modifier = Modifier.weight(1f),
        )
    }
}

/** The office form's required fields above the button ([required]) or the optional ones under «More». */
@Composable
private fun FormPart(s: SendUiState, vm: SendViewModel, required: Boolean) {
    val form = s.form
    if (form == null) {
        if (required) s.formError?.let { err ->
            InlineAlert(Tone.ATTENTION, stringResource(R.string.a1_form_unavailable) + "\n" + err) { GhostButton(stringResource(R.string.action_retry), vm::loadForm) }
        }
        return
    }
    val check = s.formCheck ?: return
    val keys = check.requiredKeys
    val any = net.palpost.library.core.forms.FormValidator.visibleFields(form, s.primaryType, s.values).any { (it.key in keys) == required }
    if (!any) return
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        if (required) {
            FieldLabel(stringResource(R.string.send_form_required))
            if (s.formCached) Text(stringResource(R.string.a1_form_cached), style = Vl.text.caption, color = Vl.colors.textSecondary)
        }
        DynamicForm(
            form, s.primaryType, s.values, ValidationResult(check.shownErrors(s.revealFormErrors)), s.picked, vm::setValue, vm::setPicked,
            include = { (it.key in keys) == required },
        )
    }
}

/** «More»: «important», the display name for this send, and the optional office fields. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun More(s: SendUiState, vm: SendViewModel) {
    val expanded = stringResource(R.string.a11y_expanded)
    val collapsed = stringResource(R.string.a11y_collapsed)
    Row(
        Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).clip(RoundedCornerShape(VlRadius.sm)).clickable(onClick = vm::toggleMore)
            .semantics { role = Role.Button; stateDescription = if (s.moreOpen) expanded else collapsed },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.send_more), style = Vl.text.headline, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
        Icon(if (s.moreOpen) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = null, tint = Vl.colors.textSecondary)
    }
    if (!s.moreOpen) return
    Row(
        Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).clickable(onClick = vm::toggleImportant).semantics(mergeDescendants = true) { role = Role.Switch },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.send_important), style = Vl.text.body, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
        Switch(
            checked = s.priority == Priority.important, onCheckedChange = { vm.toggleImportant() },
            colors = SwitchDefaults.colors(checkedTrackColor = Vl.colors.actionPrimary, checkedThumbColor = Vl.colors.textOnBrand),
        )
    }
    FieldLabel(stringResource(R.string.send_display_name))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        for (m in DISPLAY_MODES) VlChip(displayModeText(m), s.displayMode == m, { vm.setDisplayMode(m) })
    }
    if (s.displayMode == DisplayName.Mode.pseudonym) OutlinedTextField(
        value = s.pseudonym, onValueChange = vm::setPseudonym, label = { Text(stringResource(R.string.material_pseudonym)) }, singleLine = true,
        isError = s.pseudonymMissing, textStyle = Vl.text.body, colors = vlFieldColors(), shape = RoundedCornerShape(VlRadius.md), modifier = Modifier.fillMaxWidth(),
    )
    FormPart(s, vm, required = false)
}

private val DISPLAY_MODES = listOf(DisplayName.Mode.real_name, DisplayName.Mode.pseudonym, DisplayName.Mode.network)

@Composable
fun displayModeText(m: DisplayName.Mode): String = stringResource(
    when (m) { DisplayName.Mode.real_name -> R.string.display_real_name; DisplayName.Mode.pseudonym -> R.string.display_pseudonym; DisplayName.Mode.network -> R.string.display_network },
)

@Composable
private fun followupText(q: SensitivityAnswers.Question): String = stringResource(
    when (q) {
        SensitivityAnswers.Question.MINORS -> R.string.send_sensitivity_minors
        SensitivityAnswers.Question.INJURED -> R.string.send_sensitivity_injured
        SensitivityAnswers.Question.GRAPHIC -> R.string.send_sensitivity_graphic
    },
)

@Composable
private fun tagErrorText(e: TagError): String = stringResource(
    when (e) { TagError.TOO_LONG -> R.string.send_tag_too_long; TagError.LIMIT -> R.string.send_tag_limit; TagError.DUPLICATE -> R.string.send_tag_duplicate },
)

/** The disabled button's text: the first thing missing, in the screen's order. */
@Composable
fun reasonText(r: Reason): String = stringResource(
    when (r) {
        Reason.FILES -> R.string.send_need_files
        Reason.TITLE -> R.string.send_need_title
        Reason.TITLE_TOO_LONG_FOR_SET -> R.string.send_need_title_set
        Reason.TYPE -> R.string.send_need_type
        Reason.PENDING_TAG -> R.string.send_need_pending_tag
        Reason.TAGS -> R.string.send_need_tags
        Reason.PLACE -> R.string.send_need_place
        Reason.SENSITIVITY -> R.string.send_need_sensitivity
        Reason.FOLLOWUPS -> R.string.send_need_followups
        Reason.PSEUDONYM -> R.string.send_need_pseudonym
        Reason.FORM_FIELDS -> R.string.send_need_form_fields
        Reason.FORM_INVALID -> R.string.send_need_form_invalid
        Reason.FORM_LOADING -> R.string.send_need_form_loading
        Reason.FORM_UNAVAILABLE -> R.string.send_need_form_unavailable
    },
)

/** Back with unsaved input: save the draft, discard it, or keep editing (dismissing the dialog keeps editing). */
@Composable
private fun LeaveDialog(onSave: () -> Unit, onDiscard: () -> Unit, onKeep: () -> Unit) {
    AlertDialog(
        onDismissRequest = onKeep,
        title = { Text(stringResource(R.string.a1_leave_title), style = Vl.text.headline) },
        text = { Text(stringResource(R.string.a1_leave_body), style = Vl.text.body) },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                GhostButton(stringResource(R.string.a1_leave_save), onSave)
                GhostButton(stringResource(R.string.a1_leave_keep), onKeep)
                GhostButton(stringResource(R.string.a1_leave_discard), onDiscard, destructive = true)
            }
        },
    )
}
