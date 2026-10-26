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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Gavel
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSize
import net.palpost.library.ui.theme.tokens.VlSpace

/** The tones of the design system (`tone/...`): every status carries one, and an icon or text besides the colour. */
enum class Tone { NEUTRAL, PROGRESS, GOOD, ATTENTION, BAD, URGENT }

data class ToneColors(val bg: Color, val fg: Color, val border: Color)

@Composable
fun toneColors(t: Tone): ToneColors = with(Vl.colors) {
    when (t) {
        Tone.NEUTRAL -> ToneColors(toneNeutralBg, toneNeutralFg, toneNeutralBorder)
        Tone.PROGRESS -> ToneColors(toneProgressBg, toneProgressFg, toneProgressBorder)
        Tone.GOOD -> ToneColors(toneGoodBg, toneGoodFg, toneGoodBorder)
        Tone.ATTENTION -> ToneColors(toneAttentionBg, toneAttentionFg, toneAttentionBorder)
        Tone.BAD -> ToneColors(toneBadBg, toneBadFg, toneBadBorder)
        Tone.URGENT -> ToneColors(toneUrgentBg, toneUrgentFg, toneUrgentBorder)
    }
}

/** The three independent tracks of a material, each with its fixed icon and colour (design system §1.2). */
enum class Track { TECHNICAL, EDITORIAL, RIGHTS }

val Track.icon: ImageVector get() = when (this) {
    Track.TECHNICAL -> Icons.Outlined.Movie
    Track.EDITORIAL -> Icons.Outlined.Edit
    Track.RIGHTS -> Icons.Outlined.Gavel
}

@Composable
fun trackAccent(t: Track): Color = when (t) {
    Track.TECHNICAL -> Vl.colors.trackTechnicalAccent
    Track.EDITORIAL -> Vl.colors.trackEditorialAccent
    Track.RIGHTS -> Vl.colors.trackRightsAccent
}

@Composable
fun trackSubtle(t: Track): Color = when (t) {
    Track.TECHNICAL -> Vl.colors.trackTechnicalSubtle
    Track.EDITORIAL -> Vl.colors.trackEditorialSubtle
    Track.RIGHTS -> Vl.colors.trackRightsSubtle
}

/** A card on `bg/surface` with the `radius.lg` corner and the `space.5` inset. */
@Composable
fun VlCard(
    modifier: Modifier = Modifier,
    border: Color = Vl.colors.borderDefault,
    background: Color = Vl.colors.bgSurface,
    gap: androidx.compose.ui.unit.Dp = VlSpace.s4,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth().clip(RoundedCornerShape(VlRadius.lg)).background(background)
            .border(VlBorder.hairline, border, RoundedCornerShape(VlRadius.lg)).padding(VlSpace.s5),
        verticalArrangement = Arrangement.spacedBy(gap),
        content = content,
    )
}

/**
 * A state badge: track icon + localised state, on its tone. [label] is read whole by TalkBack, so it names the
 * track too ("Technical state: verified"); colour never carries the meaning alone.
 */
@Composable
fun StateBadge(track: Track?, text: String, tone: Tone, label: String = text, onClick: (() -> Unit)? = null, selected: Boolean = false) {
    val c = toneColors(tone)
    val shape = RoundedCornerShape(VlRadius.full)
    var m = Modifier.clip(shape).background(c.bg).border(if (selected) VlBorder.regular else VlBorder.hairline, if (selected) Vl.colors.borderFocus else c.border, shape)
    if (onClick != null) m = m.then(Modifier.heightIn(min = VlSize.touchCompact)).then(Modifier.clickableSemantic(onClick))
    Row(
        modifier = m.padding(horizontal = VlSpace.s3, vertical = VlSpace.s1).semantics(mergeDescendants = true) { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VlSpace.s2),
    ) {
        if (track != null) Icon(track.icon, contentDescription = null, tint = c.fg, modifier = Modifier.size(VlSize.iconSm))
        Text(text, style = Vl.text.labelSm, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

private fun Modifier.clickableSemantic(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)

/** Urgent is solid red with an icon; important and normal are outlined (design system, Priority Badge). */
@Composable
fun PriorityBadge(text: String, tone: Tone) {
    val c = toneColors(tone)
    val shape = RoundedCornerShape(VlRadius.full)
    Box(Modifier.clip(shape).background(c.bg).border(VlBorder.hairline, c.border, shape).padding(horizontal = VlSpace.s3, vertical = VlSpace.s1)) {
        Text(text, style = Vl.text.labelSm, color = c.fg)
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) =
    Text(text, style = Vl.text.headingH4, color = Vl.colors.textPrimary, modifier = modifier.semantics { heading() })

@Composable
fun Overline(text: String) = Text(text.uppercase(), style = Vl.text.overlineMd, color = Vl.colors.textSecondary)

/** The one primary action of a screen: full width, `size.control-md` tall, `radius.md`. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leading: ImageVector? = null) {
    Button(
        onClick = onClick, enabled = enabled, shape = RoundedCornerShape(VlRadius.md),
        colors = ButtonDefaults.buttonColors(containerColor = Vl.colors.bgBrand, contentColor = Vl.colors.textOnBrand, disabledContainerColor = Vl.colors.bgDisabled, disabledContentColor = Vl.colors.textDisabled),
        modifier = modifier.fillMaxWidth().heightIn(min = VlSize.controlMd),
    ) {
        if (leading != null) { Icon(leading, contentDescription = null, modifier = Modifier.size(VlSize.iconMd)); Box(Modifier.width(VlSpace.s3)) }
        Text(text, style = Vl.text.labelLg)
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, leading: ImageVector? = null) {
    OutlinedButton(
        onClick = onClick, enabled = enabled, shape = RoundedCornerShape(VlRadius.md), border = BorderStroke(VlBorder.hairline, Vl.colors.borderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Vl.colors.textPrimary), modifier = modifier.heightIn(min = VlSize.controlMd),
    ) {
        if (leading != null) { Icon(leading, contentDescription = null, modifier = Modifier.size(VlSize.iconMd)); Box(Modifier.width(VlSpace.s3)) }
        Text(text, style = Vl.text.labelLg)
    }
}

@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    TextButton(onClick = onClick, enabled = enabled, colors = ButtonDefaults.textButtonColors(contentColor = Vl.colors.textBrand), modifier = modifier.heightIn(min = VlSize.touchMin)) {
        Text(text, style = Vl.text.labelLg)
    }
}

/** An inline alert on its tone, with an optional action row. */
@Composable
fun InlineAlert(tone: Tone, text: String, icon: ImageVector? = null, actions: (@Composable RowScope.() -> Unit)? = null) {
    val c = toneColors(tone)
    VlCard(background = c.bg, border = c.border, gap = VlSpace.s3) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.Top) {
            if (icon != null) Icon(icon, contentDescription = null, tint = c.fg, modifier = Modifier.size(VlSize.iconMd))
            Text(text, style = Vl.text.bodySm, color = c.fg)
        }
        if (actions != null) Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** The step indicator of A1: [total] bars `space.3` apart and 4 tall, done in `bg/brand`, the rest `border/default`. */
@Composable
fun Stepper(step: Int, total: Int, caption: String) {
    Column(verticalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = caption }) {
        Row(horizontalArrangement = Arrangement.spacedBy(VlSpace.s3), modifier = Modifier.fillMaxWidth()) {
            for (i in 1..total) {
                Box(Modifier.weight(1f).height(VlSpace.s2).clip(RoundedCornerShape(VlRadius.full)).background(if (i <= step) Vl.colors.bgBrand else Vl.colors.borderDefault))
            }
        }
        Text(caption, style = Vl.text.captionMd, color = Vl.colors.textSecondary)
    }
}

/** Urgent is solid red, important is attention, normal is neutral. */
fun priorityTone(p: net.palpost.library.api.models.Priority): Tone = when (p.value) {
    "urgent" -> Tone.URGENT
    "important" -> Tone.ATTENTION
    else -> Tone.NEUTRAL
}

/** True when the system's animator scale is off ("remove animations"): motion then snaps (spec §1, reduce motion). */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = androidx.compose.ui.platform.LocalContext.current
    return androidx.compose.runtime.remember {
        android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}
