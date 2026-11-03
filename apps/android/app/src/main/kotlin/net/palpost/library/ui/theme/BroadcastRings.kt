package net.palpost.library.ui.theme

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import net.palpost.library.core.send.UploadOverview.RingState
import net.palpost.library.ui.theme.tokens.VlBorder
import net.palpost.library.ui.theme.tokens.VlMotion

/**
 * `Broadcast rings` from the network's logo (ADR 0085): they pulse while uploading, calm while waiting for the network, fill on
 * arrival and turn red on a failure that needs the reporter. «Remove animations» stops the pulse; the percentage and the word
 * stay. TalkBack reads [a11y] (the percentage and the state) as one element.
 */
@Composable
fun BroadcastRings(
    state: RingState,
    fraction: Float,
    diameter: Dp,
    a11y: String,
    modifier: Modifier = Modifier,
    percent: String? = null,
    caption: String? = null,
) {
    val c = Vl.colors
    val reduceMotion = rememberReduceMotion()
    val tone = when (state) { RingState.FAILED -> c.stateDanger; RingState.WAITING -> c.stateMuted; else -> c.actionPrimary }
    val pulsing = state == RingState.UPLOADING && !reduceMotion
    val transition = rememberInfiniteTransition(label = "rings")
    val phase by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(VlMotion.pulseMs, easing = LinearEasing), RepeatMode.Restart), label = "pulse")
    val shown by animateFloatAsState(fraction.coerceIn(0f, 1f), if (reduceMotion) tween(0) else tween(VlMotion.slowMs), label = "fraction")
    Box(modifier.size(diameter).clearAndSetSemantics { contentDescription = a11y }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val r = size.minDimension / 2
            val ring = VlBorder.ring.toPx()
            for ((i, k) in listOf(1f, 0.86f, 0.72f).withIndex()) {
                // While uploading each ring fades in turn, as a signal leaving the centre.
                val a = if (pulsing) 0.35f + 0.65f * (1f - ((phase + i / 3f) % 1f)) else if (state == RingState.WAITING) 0.45f else 1f
                drawCircle(tone, radius = r * k - ring, style = Stroke(ring), alpha = a)
            }
            val inner = r * 0.56f
            if (state == RingState.DONE) {
                drawCircle(tone, radius = inner)
            } else {
                val w = VlBorder.progress.toPx()
                drawCircle(c.borderLine, radius = inner - w / 2, style = Stroke(w))
                val d = (inner - w / 2) * 2
                drawArc(
                    tone, startAngle = -90f, sweepAngle = 360f * shown, useCenter = false,
                    topLeft = Offset(center.x - d / 2, center.y - d / 2), size = Size(d, d), style = Stroke(w, cap = StrokeCap.Round),
                )
            }
        }
        if (state == RingState.DONE) {
            Icon(Icons.Outlined.Check, contentDescription = null, tint = c.textOnBrand, modifier = Modifier.size(diameter * 0.22f))
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (percent != null) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    Text(percent, style = Vl.text.bigNumber, color = c.textPrimary)
                }
                if (caption != null) Text(caption, style = Vl.text.caption, color = c.textSecondary)
            }
        }
    }
}
