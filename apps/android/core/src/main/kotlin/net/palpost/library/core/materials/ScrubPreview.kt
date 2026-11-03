package net.palpost.library.core.materials

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import kotlin.math.roundToInt

// The frame above the seek bar while the reporter drags it (ADR 0106, the follow-up ADR 0095 left). Pure logic, tested on the JVM.

/** Where the bubble's picture comes from. */
sealed interface ScrubPreviewSource {
    /** Frames of the verified light copy, read through its signed link and decoded small, in memory only. */
    data class LightCopy(val fileId: String) : ScrubPreviewSource

    /** No picture: the bubble shows the time alone. */
    data object TimeOnly : ScrubPreviewSource
}

object ScrubPreviewPolicy {
    /** One frame per second at most, and no more than this many in a whole video: a drag never asks for more. */
    const val MIN_STEP_MS = 1_000L
    const val MAX_FRAMES = 100

    /**
     * Frames come from the verified light copy (`proxy`, a video) alone, whatever the player plays: never the original (the
     * contract gives no link for it, and the phone's copy is full size), and not the poster `thumbnail`, which is one frame at
     * one moment and would show the wrong picture everywhere else. A sensitive material asks the server for frames only when
     * the reporter is already watching it from the server; from the phone's own copy it shows the time alone.
     */
    fun source(m: Material, playing: PlaybackSource): ScrubPreviewSource {
        if (playing == PlaybackSource.Unavailable) return ScrubPreviewSource.TimeOnly
        if (m.isSensitive && playing !is PlaybackSource.Remote) return ScrubPreviewSource.TimeOnly
        val proxy = PlaybackSourcePolicy.newestVerified(MaterialFile.Kind.proxy, m) { it.mimeType?.lowercase()?.startsWith("image/") != true }
            ?: return ScrubPreviewSource.TimeOnly
        return ScrubPreviewSource.LightCopy(proxy.id.toString())
    }

    /** The moment whose frame is asked for: the drag position rounded down to the step, within the video. */
    fun bucket(positionMs: Long, durationMs: Long): Long {
        val step = maxOf(MIN_STEP_MS, if (durationMs > 0) durationMs / MAX_FRAMES else 0L)
        val at = if (durationMs > 0) positionMs.coerceIn(0L, durationMs) else positionMs.coerceAtLeast(0L)
        return at / step * step
    }
}

/**
 * Where the bubble sits, in window pixels: centred over the thumb (the track is inset by [insetPx] at each end), never past
 * the window's edges, and [gapPx] above the seek bar; it never covers the finger on the bar.
 */
object ScrubBubblePlacement {
    data class Offset(val x: Int, val y: Int)

    fun place(anchorLeft: Int, anchorTop: Int, anchorWidth: Int, insetPx: Int, fraction: Float, bubbleWidth: Int, bubbleHeight: Int, windowWidth: Int, gapPx: Int): Offset {
        val track = (anchorWidth - 2 * insetPx).coerceAtLeast(0)
        val f = if (fraction.isNaN()) 0f else fraction.coerceIn(0f, 1f)
        val centre = anchorLeft + insetPx + (f * track).roundToInt()
        val x = (centre - bubbleWidth / 2).coerceIn(0, (windowWidth - bubbleWidth).coerceAtLeast(0))
        val y = (anchorTop - bubbleHeight - gapPx).coerceAtLeast(0)
        return Offset(x, y)
    }
}

/** A frame for the moment [atMs]. */
data class ScrubFrame<F : Any>(val atMs: Long, val frame: F)

/**
 * The frames shown while dragging: the last request wins (moments asked for while one is being read are dropped, except the
 * latest), a frame read once is kept in memory for the rest of this player's life (at most [capacity], least recently used
 * out first), and after [maxFailures] reads in a row without a frame no more are asked for, so a dead link never loops.
 * [close] drops every frame and any read still in flight; nothing is ever written to disk.
 */
class ScrubFrames<F : Any>(
    scope: CoroutineScope,
    private val capacity: Int = 32,
    private val maxFailures: Int = 3,
    private val read: suspend (atMs: Long) -> F?,
) {
    private val requests = Channel<Long>(Channel.CONFLATED)
    private val cache = object : LinkedHashMap<Long, F>(capacity, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, F>?): Boolean = size > capacity
    }
    private val _shown = MutableStateFlow<ScrubFrame<F>?>(null)
    private var failures = 0
    @Volatile private var closed = false
    private val worker: Job

    /** The latest frame read for a requested moment; null before the first, and after [close]. */
    val shown: StateFlow<ScrubFrame<F>?> = _shown

    /** No more reads: [maxFailures] in a row gave nothing. */
    val gaveUp: Boolean get() = failures >= maxFailures

    /** Reads asked of [read] so far (for the tests and the field check: one per moment at most). */
    @Volatile var reads = 0
        private set

    init {
        worker = scope.launch {
            for (at in requests) {
                if (closed) break
                val known = synchronized(cache) { cache[at] }
                if (known != null) { _shown.value = ScrubFrame(at, known); continue }
                if (gaveUp) continue
                reads++
                val frame = runCatching { read(at) }.getOrNull()
                if (closed) break
                if (frame == null) { failures++; continue }
                failures = 0
                synchronized(cache) { cache[at] = frame }
                _shown.value = ScrubFrame(at, frame)
            }
        }
    }

    /** Asks for the frame at [atMs] (already a bucket); shows it at once if it was read before. */
    fun request(atMs: Long) {
        if (closed) return
        synchronized(cache) { cache[atMs] }?.let { _shown.value = ScrubFrame(atMs, it) }
        requests.trySend(atMs)
    }

    fun close() {
        closed = true
        requests.close()
        worker.cancel()
        synchronized(cache) { cache.clear() }
        _shown.value = null
    }
}
