package net.palpost.library.ui.theme

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.LayoutDirection
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace

/** One picked file as the send screen shows it: a thumbnail the system gave (never a copy), and whether it is a video. */
data class FileTile(val key: String, val thumbnail: ImageBitmap?, val video: Boolean, val removeLabel: String)

/**
 * The files of the send (04): thumbnails in a row that scrolls, each with a 48dp remove button that drops the file from this
 * send only (the phone's file and the upload queue are untouched), then an add tile; the count and size above them.
 */
@Composable
fun FilesStrip(summary: String, tiles: List<FileTile>, addLabel: String, canAdd: Boolean, onAdd: () -> Unit, onRemove: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        Text(summary, style = Vl.text.num, color = Vl.colors.textPrimary)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
            val shape = RoundedCornerShape(VlRadius.md)
            for (t in tiles) {
                Box(Modifier.size(width = VlSpace.s11 + VlSpace.s3, height = VlSpace.s11 + VlSpace.s7).clip(shape).background(Vl.colors.bgSunken)) {
                    if (t.thumbnail != null) Image(t.thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
                    else Icon(if (t.video) Icons.Outlined.Movie else Icons.Outlined.Image, contentDescription = null, tint = Vl.colors.textSecondary, modifier = Modifier.align(Alignment.Center))
                    Box(
                        Modifier.align(Alignment.TopEnd).size(MinTouchTarget).clickable { onRemove(t.key) }.semantics { role = Role.Button; contentDescription = t.removeLabel },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(VlSpace.s7).clip(RoundedCornerShape(VlRadius.full)).background(Vl.colors.bgRaised), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Close, contentDescription = null, tint = Vl.colors.textPrimary, modifier = Modifier.size(VlIcon.sm))
                        }
                    }
                }
            }
            if (canAdd) Box(
                Modifier.size(width = VlSpace.s11 + VlSpace.s3, height = VlSpace.s11 + VlSpace.s7).clip(shape)
                    .border(VlBorder.field, Vl.colors.borderEdge, shape).clickable(onClick = onAdd).semantics { role = Role.Button; contentDescription = addLabel },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Outlined.Add, contentDescription = null, tint = Vl.colors.textBrand) }
        }
    }
}

/** The coverage title with its counter, always left to right («38/80»). */
@Composable
fun TitleField(label: String, value: String, onChange: (String) -> Unit, count: Int, max: Int, isError: Boolean, help: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        FieldLabel(label)
        OutlinedTextField(
            value = value, onValueChange = onChange, singleLine = true, isError = isError, textStyle = Vl.text.body,
            shape = RoundedCornerShape(VlRadius.md), modifier = Modifier.fillMaxWidth().heightIn(min = VlSize.fieldMin),
            colors = vlFieldColors(),
            trailingIcon = {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    Text("$count/$max", style = Vl.text.caption, color = if (isError) Vl.colors.stateDanger else Vl.colors.textSecondary, modifier = Modifier.padding(horizontal = VlSpace.s3))
                }
            },
        )
        if (help != null) Text(help, style = Vl.text.caption, color = if (isError) Vl.colors.stateDanger else Vl.colors.textSecondary)
    }
}

/** Text fields with the v2 borders: `border/edge` at the field width, brand when focused, danger on error. */
@Composable
fun vlFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Vl.colors.actionPrimary, unfocusedBorderColor = Vl.colors.borderEdge, errorBorderColor = Vl.colors.stateDanger,
    focusedContainerColor = Vl.colors.bgRaised, unfocusedContainerColor = Vl.colors.bgRaised, errorContainerColor = Vl.colors.bgRaised,
    cursorColor = Vl.colors.actionPrimary, focusedTextColor = Vl.colors.textPrimary, unfocusedTextColor = Vl.colors.textPrimary,
)

/**
 * The coverage type (`material_types[]`, at least one): the first four as chips and the rest behind «More», in a named group.
 * [labelOf] gives each contract value its word.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun <T> CoverageTypeChips(groupLabel: String, moreLabel: String, all: List<T>, selected: Set<T>, labelOf: @Composable (T) -> String, onToggle: (T) -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val shown = if (expanded || all.drop(4).any { it in selected }) all else all.take(4)
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2), modifier = Modifier.semantics { contentDescription = groupLabel }) {
        FieldLabel(groupLabel)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
            for (t in shown) VlChip(labelOf(t), t in selected, { onToggle(t) })
            if (shown.size < all.size) VlChip(moreLabel, false, { expanded = true }, leading = Icons.Outlined.Add)
        }
    }
}

/**
 * `Tag input`: chips with a full 48dp remove button, then free text ended by a comma (Latin or Arabic), «done» or leaving the
 * field, and suggestions from the reporter's earlier tags. [error] says why the typed tag was not added.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagInput(
    label: String,
    placeholder: String,
    tags: List<String>,
    text: String,
    onText: (String) -> Unit,
    onCommit: () -> Unit,
    onRemove: (String) -> Unit,
    removeLabel: @Composable (String) -> String,
    error: String?,
    suggestionsLabel: String,
    suggestions: List<String>,
    onSuggestion: (String) -> Unit,
) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.md)
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        FieldLabel(label)
        Column(
            Modifier.fillMaxWidth().clip(shape).background(c.bgRaised).border(VlBorder.field, if (error != null) c.stateDanger else c.borderEdge, shape).padding(VlSpace.s3),
            verticalArrangement = Arrangement.spacedBy(VlSpace.s2),
        ) {
            if (tags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), verticalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                for (t in tags) {
                    val remove = removeLabel(t)
                    Row(
                    Modifier.heightIn(min = MinTouchTarget).clip(RoundedCornerShape(VlRadius.chip)).background(c.bgSunken).padding(start = VlSpace.s4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(t, style = Vl.text.chip, color = c.textPrimary)
                    Box(Modifier.size(MinTouchTarget).clickable { onRemove(t) }.semantics { role = Role.Button; contentDescription = remove }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Close, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(VlIcon.sm))
                    }
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), modifier = Modifier.heightIn(min = MinTouchTarget)) {
                Icon(Icons.Outlined.Add, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(VlIcon.sm))
                Box(Modifier.weight(1f)) {
                    if (text.isEmpty()) Text(placeholder, style = Vl.text.body, color = c.textSecondary)
                    var focused by rememberSaveable { mutableStateOf(false) }
                    BasicTextField(
                        value = text, onValueChange = onText, singleLine = true, textStyle = Vl.text.body.copy(color = c.textPrimary),
                        cursorBrush = SolidColor(c.actionPrimary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { onCommit() }),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label }.onFocusChanged { f ->
                            if (focused && !f.isFocused) onCommit()
                            focused = f.isFocused
                        },
                    )
                }
            }
        }
        if (error != null) Text(error, style = Vl.text.caption, color = c.stateDanger)
        if (suggestions.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), modifier = Modifier.horizontalScroll(rememberScrollState())) {
            Text(suggestionsLabel, style = Vl.text.caption, color = c.textSecondary)
            for (s in suggestions) VlChip(s, false, { onSuggestion(s) }, leading = Icons.Outlined.Add)
        }
    }
}

/**
 * `Location chip`: the governorate and city remembered from the last send, with «From your last send» under them; tapping opens
 * the two fields. Never coordinates (the filming location is collected separately and never shown, ADR 0087).
 */
@Composable
fun PlaceChip(
    place: String?,
    note: String,
    editLabel: String,
    modifier: Modifier = Modifier,
    onEdit: () -> Unit,
) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.md)
    Row(
        modifier.heightIn(min = VlSize.ctaMin + VlSpace.s4).clip(shape).background(c.bgSunken).clickable(onClick = onEdit)
            .semantics(mergeDescendants = true) { role = Role.Button; stateDescription = editLabel }.padding(horizontal = VlSpace.s4, vertical = VlSpace.s3),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3),
    ) {
        Icon(Icons.Outlined.Place, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(VlIcon.md))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(VlSpace.s1)) {
            if (place != null) Text(place, style = Vl.text.headline, color = c.textPrimary)
            Text(note, style = Vl.text.caption, color = c.textSecondary)
        }
    }
}

/** `Urgent toggle`: outlined in the urgent colour, filled when on; a switch for TalkBack. */
@Composable
fun UrgentToggle(label: String, on: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.md)
    val fg = if (on) c.textOnBrand else c.priorityUrgent
    Column(
        modifier.heightIn(min = VlSize.ctaMin + VlSpace.s4).width(VlSpace.s12 + VlSpace.s3).clip(shape)
            .then(if (on) Modifier.background(c.priorityUrgent, shape) else Modifier.border(VlBorder.field, c.priorityUrgent, shape))
            .clickable(onClick = onToggle).semantics(mergeDescendants = true) { role = Role.Switch; selected = on }.padding(VlSpace.s3),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s1, Alignment.CenterVertically),
    ) {
        Icon(Icons.Outlined.Bolt, contentDescription = null, tint = fg, modifier = Modifier.size(VlIcon.md))
        Text(label, style = Vl.text.label, color = fg)
    }
}

/** A No/Yes pair with no preset answer, as one named group; the selected answer is dark ink and «selected» for TalkBack. */
@Composable
fun YesNo(question: String, value: Boolean?, yes: String, no: String, onAnswer: (Boolean) -> Unit, modifier: Modifier = Modifier, style: androidx.compose.ui.text.TextStyle = Vl.text.body) {
    Row(modifier.fillMaxWidth().semantics { contentDescription = question }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s3)) {
        Text(question, style = style, color = Vl.colors.textPrimary, modifier = Modifier.weight(1f))
        VlChip(no, value == false, { onAnswer(false) })
        VlChip(yes, value == true, { onAnswer(true) })
    }
}

/**
 * `Sensitivity question`: one question that is never skipped and has no preset answer, on the sensitivity surface with a
 * clearer border for working in the sun; «Yes» opens the three follow-ups, each answered explicitly (04, 04b, 04c).
 */
@Composable
fun SensitivityQuestion(
    question: String,
    gate: Boolean?,
    followups: List<Pair<String, Boolean?>>?,
    yes: String,
    no: String,
    onGate: (Boolean) -> Unit,
    onFollowup: (Int, Boolean) -> Unit,
) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.md)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.sensitivityBg).border(VlBorder.field, c.sensitivityBorder, shape).padding(VlSpace.s4),
        verticalArrangement = Arrangement.spacedBy(VlSpace.s3),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.Shield, contentDescription = null, tint = c.textPrimary, modifier = Modifier.size(VlIcon.md))
            Text(question, style = Vl.text.headline, color = c.textPrimary, modifier = Modifier.semantics { heading() })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.semantics { contentDescription = question }) {
            VlChip(no, gate == false, { onGate(false) }, modifier = Modifier.weight(1f))
            VlChip(yes, gate == true, { onGate(true) }, modifier = Modifier.weight(1f))
        }
        followups?.forEachIndexed { i, (q, v) -> YesNo(q, v, yes, no, { onFollowup(i, it) }) }
    }
}
