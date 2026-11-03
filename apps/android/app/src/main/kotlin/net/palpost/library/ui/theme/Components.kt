package net.palpost.library.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HighlightOff
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.PriorityHigh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace

/**
 * The smallest touch target of any control on Android (Material and WCAG 2.5.8: 48dp); `size.touch-min` (44) is the iOS figure,
 * so every interactive element here takes the larger one.
 */
val MinTouchTarget = 48.dp

/**
 * What a state means, as the screens decide it (the iOS `MaterialStatus.Tone`); the colour comes from [Signal] by track, so the
 * three tracks keep their own tones (design-system-v2.md «نغمات الحالات»).
 */
enum class Tone { NEUTRAL, PROGRESS, GOOD, ATTENTION, BAD, URGENT }

/** The v2 state tones (`color.state.*`): each badge also carries an icon and a word, never colour alone. */
enum class Signal { OK, WARN, MUTED, BRAND, DANGER, URGENT }

@Composable
fun signalColor(s: Signal): Color = with(Vl.colors) {
    when (s) {
        Signal.OK -> stateOk
        Signal.WARN -> stateWarn
        Signal.MUTED -> stateMuted
        Signal.BRAND -> stateBrand
        Signal.DANGER -> stateDanger
        Signal.URGENT -> priorityUrgent
    }
}

/** The three independent tracks of a material. */
enum class Track { TECHNICAL, EDITORIAL, RIGHTS }

/**
 * A tone on its track (`material-state.*` in tokens.v2.json): technical (ready ok, processing muted, failed danger) · editorial
 * (in review warn, approved ok, rejected danger) · rights (internal muted, listed brand, restricted warn).
 */
fun signalOf(tone: Tone, track: Track?): Signal = when (track) {
    Track.TECHNICAL -> when (tone) { Tone.GOOD -> Signal.OK; Tone.BAD -> Signal.DANGER; else -> Signal.MUTED }
    Track.EDITORIAL -> when (tone) { Tone.GOOD -> Signal.OK; Tone.BAD -> Signal.DANGER; else -> Signal.WARN }
    Track.RIGHTS -> when (tone) { Tone.GOOD -> Signal.BRAND; Tone.BAD -> Signal.WARN; else -> Signal.MUTED }
    null -> when (tone) {
        Tone.NEUTRAL -> Signal.MUTED
        Tone.PROGRESS -> Signal.BRAND
        Tone.GOOD -> Signal.OK
        Tone.ATTENTION -> Signal.WARN
        Tone.BAD -> Signal.DANGER
        Tone.URGENT -> Signal.URGENT
    }
}

/** Each tone's icon on its track: ✓ ready/approved, clock processing/internal, warning failed, pen in review, ✕ rejected, key listed, lock restricted. */
fun trackIcon(track: Track?, signal: Signal): ImageVector = when {
    signal == Signal.OK -> Icons.Outlined.Check
    track == Track.TECHNICAL && signal == Signal.DANGER -> Icons.Outlined.ErrorOutline
    signal == Signal.DANGER -> Icons.Outlined.HighlightOff
    track == Track.EDITORIAL -> Icons.Outlined.Edit
    track == Track.RIGHTS && signal == Signal.BRAND -> Icons.Outlined.Key
    track == Track.RIGHTS && signal == Signal.WARN -> Icons.Outlined.Lock
    signal == Signal.URGENT -> Icons.Outlined.Bolt
    signal == Signal.WARN -> Icons.Outlined.PriorityHigh
    else -> Icons.Outlined.Schedule
}

/** A card on `bg/raised` with the `radius.md` corner, a `border/line` hairline and the `space.5` inset. */
@Composable
fun VlCard(
    modifier: Modifier = Modifier,
    border: Color = Vl.colors.borderLine,
    background: Color = Vl.colors.bgRaised,
    gap: Dp = VlSpace.s4,
    padding: Dp = VlSpace.s5,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(VlRadius.md)
    Column(
        modifier = modifier.fillMaxWidth().clip(shape).background(background).border(VlBorder.hairline, border, shape).padding(padding),
        verticalArrangement = Arrangement.spacedBy(gap),
        content = content,
    )
}

/**
 * `State badge`: icon and word in a tone. [label] is what TalkBack reads, naming the track too («Technical state: ready»), so
 * colour never carries the meaning alone. With [onClick] the badge becomes a 48dp target.
 */
@Composable
fun StateBadge(text: String, signal: Signal, icon: ImageVector? = null, label: String = text, onClick: (() -> Unit)? = null, selected: Boolean = false) {
    val color = signalColor(signal)
    var m: Modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = label }
    if (onClick != null) {
        val shape = RoundedCornerShape(VlRadius.full)
        m = Modifier.heightIn(min = MinTouchTarget).clip(shape)
            .then(if (selected) Modifier.border(VlBorder.field, color, shape) else Modifier)
            .clickable(onClick = onClick).padding(horizontal = VlSpace.s3).then(m)
    }
    Row(modifier = m, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
        if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(VlIcon.sm))
        Text(text, style = Vl.text.caption, color = color)
    }
}

/** A track's badge: the icon of its tone on that track. */
@Composable
fun TrackBadge(track: Track, tone: Tone, text: String, trackName: String, onClick: (() -> Unit)? = null, selected: Boolean = false) {
    val signal = signalOf(tone, track)
    StateBadge(text, signal, trackIcon(track, signal), "$trackName: $text", onClick, selected)
}

/** Urgent is red with a bolt; important is a warning; normal shows nothing. */
@Composable
fun PriorityBadge(text: String, tone: Tone) {
    val signal = signalOf(tone, null)
    StateBadge(text, signal, if (signal == Signal.URGENT) Icons.Outlined.Bolt else Icons.Outlined.PriorityHigh)
}

/** The «sensitive» badge: a shield, in the sensitivity border colour. */
@Composable
fun SensitiveBadge(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2), modifier = Modifier.semantics(mergeDescendants = true) {}) {
        Icon(Icons.Outlined.Shield, contentDescription = null, tint = Vl.colors.sensitivityBorder, modifier = Modifier.size(VlIcon.sm))
        Text(text, style = Vl.text.caption, color = Vl.colors.sensitivityBorder)
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) =
    Text(text, style = Vl.text.headline, color = Vl.colors.textPrimary, modifier = modifier.semantics { heading() })

/** A field's label above it (`label` role, secondary text). */
@Composable
fun FieldLabel(text: String, modifier: Modifier = Modifier) = Text(text, style = Vl.text.label, color = Vl.colors.textSecondary, modifier = modifier)

/** `Button` kinds: Primary (the gradient, for «Send» and the home's big button alone) · Solid (the main action) · Outline. */
enum class ButtonKind { PRIMARY, SOLID, OUTLINE }

/** `Button` sizes: the home's big «Send from the field» · Large (`size.cta-min`) · Small (the 48dp touch minimum). */
enum class ButtonSize { HERO, LARGE, SMALL }

/**
 * The v2 button (design-system-v2.md «المكوّنات»): `radius.md`, text in the button role. A disabled button is a sunken surface
 * with secondary text that stays readable, because its text may be the reason it is disabled (ADR 0088). A destructive outline
 * takes the danger colour.
 */
@Composable
fun VlButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.SOLID,
    size: ButtonSize = ButtonSize.LARGE,
    enabled: Boolean = true,
    destructive: Boolean = false,
    leading: ImageVector? = null,
    fullWidth: Boolean = true,
) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.md)
    val minHeight = when (size) { ButtonSize.HERO -> VlSpace.s11 + VlSpace.s3; ButtonSize.LARGE -> VlSize.ctaMin; ButtonSize.SMALL -> MinTouchTarget }
    val fg = when {
        !enabled -> c.textSecondary
        kind == ButtonKind.OUTLINE -> if (destructive) c.stateDanger else c.textPrimary
        else -> c.textOnBrand
    }
    val bg: Modifier = when {
        !enabled && kind != ButtonKind.OUTLINE -> Modifier.background(c.bgSunken, shape)
        kind == ButtonKind.PRIMARY -> Modifier.background(Brush.linearGradient(listOf(c.actionPrimary, c.actionGradientEnd), start = Offset.Zero, end = Offset.Infinite), shape)
        kind == ButtonKind.SOLID -> Modifier.background(c.actionPrimary, shape)
        else -> Modifier.border(VlBorder.field, if (destructive) c.stateDanger else c.borderEdge, shape)
    }
    Row(
        modifier = modifier.then(if (fullWidth) Modifier.fillMaxWidth() else Modifier).heightIn(min = minHeight).widthIn(min = MinTouchTarget)
            .clip(shape).then(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { role = Role.Button }
            .padding(horizontal = if (size == ButtonSize.SMALL) VlSpace.s5 else VlSpace.s6, vertical = VlSpace.s3),
        horizontalArrangement = Arrangement.spacedBy(VlSpace.s3, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) Icon(leading, contentDescription = null, tint = fg, modifier = Modifier.size(VlIcon.md))
        Text(text, style = if (size == ButtonSize.HERO) Vl.text.title else Vl.text.button, color = fg, textAlign = TextAlign.Center)
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leading: ImageVector? = null, size: ButtonSize = ButtonSize.LARGE) =
    VlButton(text, onClick, modifier, ButtonKind.PRIMARY, size, enabled, leading = leading)

@Composable
fun SolidButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leading: ImageVector? = null, fullWidth: Boolean = true) =
    VlButton(text, onClick, modifier, ButtonKind.SOLID, ButtonSize.LARGE, enabled, leading = leading, fullWidth = fullWidth)

@Composable
fun OutlineButton(
    text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leading: ImageVector? = null,
    destructive: Boolean = false, small: Boolean = false, fullWidth: Boolean = !small,
) = VlButton(text, onClick, modifier, ButtonKind.OUTLINE, if (small) ButtonSize.SMALL else ButtonSize.LARGE, enabled, destructive, leading, fullWidth)

/** A text button without a frame (links and small secondary actions): 48dp target, brand colour, danger when destructive. */
@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, destructive: Boolean = false, leading: ImageVector? = null) {
    val color = when { !enabled -> Vl.colors.textSecondary; destructive -> Vl.colors.stateDanger; else -> Vl.colors.textBrand }
    Row(
        modifier = modifier.heightIn(min = MinTouchTarget).widthIn(min = MinTouchTarget).clip(RoundedCornerShape(VlRadius.sm))
            .clickable(enabled = enabled, onClick = onClick).semantics { role = Role.Button }.padding(horizontal = VlSpace.s3),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2, Alignment.CenterHorizontally),
    ) {
        if (leading != null) Icon(leading, contentDescription = null, tint = color, modifier = Modifier.size(VlIcon.sm))
        Text(text, style = Vl.text.action, color = color)
    }
}

/** A round icon button (close, settings, notifications): 48dp, on `bg/sunken`, with the name TalkBack reads. */
@Composable
fun VlIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = Vl.colors.textPrimary) {
    IconButton(onClick = onClick, modifier = modifier.size(MinTouchTarget).clip(CircleShape).background(Vl.colors.bgSunken)) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(VlIcon.md))
    }
}

/** A note in a tone: icon and text on `bg/sunken`, with an optional action row. */
@Composable
fun InlineAlert(tone: Tone, text: String, icon: ImageVector? = null, actions: (@Composable RowScope.() -> Unit)? = null) {
    val color = signalColor(signalOf(tone, null))
    VlCard(background = Vl.colors.bgSunken, border = if (tone == Tone.BAD || tone == Tone.ATTENTION) color else Vl.colors.borderLine, gap = VlSpace.s3, padding = VlSpace.s4) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.Top) {
            if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(VlIcon.md))
            Text(text, style = Vl.text.body, color = Vl.colors.textPrimary)
        }
        if (actions != null) Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** `Empty state`: an icon in a soft circle, a title, a line, and one action. */
@Composable
fun EmptyState(icon: ImageVector, title: String, body: String, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = VlSpace.s8), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s4)) {
        Box(Modifier.size(VlSpace.s11 + VlSpace.s5).clip(CircleShape).background(Vl.colors.actionSoft), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = Vl.colors.textBrand, modifier = Modifier.size(VlIcon.lg))
        }
        Text(title, style = Vl.text.title, color = Vl.colors.textPrimary, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(body, style = Vl.text.body, color = Vl.colors.textSecondary, textAlign = TextAlign.Center)
        action?.invoke()
    }
}

/** A chip (`Chip`): selected is dark ink with a heavier weight and the «selected» state; one size in both states. */
@Composable
fun VlChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, leading: ImageVector? = null) {
    val c = Vl.colors
    val shape = RoundedCornerShape(VlRadius.chip)
    Row(
        modifier = modifier.heightIn(min = MinTouchTarget).clip(shape)
            .then(if (selected) Modifier.background(c.textPrimary, shape) else Modifier.background(c.bgRaised, shape).border(BorderStroke(VlBorder.field, c.borderEdge), shape))
            .clickable(onClick = onClick)
            .semantics { role = Role.Checkbox; this.selected = selected }
            .padding(horizontal = VlSpace.s4),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2),
    ) {
        if (leading != null) Icon(leading, contentDescription = null, tint = if (selected) c.bgRaised else c.textPrimary, modifier = Modifier.size(VlIcon.sm))
        Text(text, style = if (selected) Vl.text.chipSelected else Vl.text.chip, color = if (selected) c.bgRaised else c.textPrimary)
    }
}

/** True when the system's animator scale is off («remove animations»): motion then stops and the meaning stays. */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

/** Text that must read left to right inside Arabic (numbers, slash, brackets): display only, never stored or sent. */
fun ltr(text: String): String = Char(0x2066) + text + Char(0x2069)

/** Spacer helper for rows. */
@Composable
fun HSpace(width: Dp) = Box(Modifier.width(width))

/** Urgent, important, normal by contract value. */
fun priorityTone(p: net.palpost.library.api.models.Priority): Tone = when (p.value) {
    "urgent" -> Tone.URGENT
    "important" -> Tone.ATTENTION
    else -> Tone.NEUTRAL
}
