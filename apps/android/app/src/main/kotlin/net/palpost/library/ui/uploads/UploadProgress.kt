package net.palpost.library.ui.uploads

import kotlin.math.ceil

/** What one bar in the part row of A2 shows. */
enum class PartState { CONFIRMED, CURRENT, LATER }

/**
 * The upload's parts as A2 draws them: "n of m parts confirmed by the server · part k in progress", at most
 * [maxBars] bars (parts are grouped when there are more). A part is the session's `part_size_bytes`; before a
 * session exists the file is cut into [maxBars] equal parts. Only bytes the server confirmed count.
 */
data class UploadParts(val total: Int, val confirmed: Int, val current: Int?, val bars: List<PartState>) {
    companion object {
        fun of(sizeBytes: Long, confirmedBytes: Long, partSizeBytes: Long?, active: Boolean, maxBars: Int = 12): UploadParts {
            if (sizeBytes <= 0) return UploadParts(0, 0, null, emptyList())
            val part = partSizeBytes?.takeIf { it > 0 } ?: ceil(sizeBytes / maxBars.toDouble()).toLong().coerceAtLeast(1)
            val total = ceil(sizeBytes / part.toDouble()).toInt()
            val done = if (confirmedBytes >= sizeBytes) total else (confirmedBytes.coerceAtLeast(0) / part).toInt()
            val current = if (active && done < total) done + 1 else null
            val perBar = ceil(total / maxBars.toDouble()).toInt().coerceAtLeast(1)
            val bars = (0 until ceil(total / perBar.toDouble()).toInt()).map { b ->
                val first = b * perBar + 1
                val last = minOf(total, first + perBar - 1)
                when {
                    last <= done -> PartState.CONFIRMED
                    current != null && current in first..last -> PartState.CURRENT
                    else -> PartState.LATER
                }
            }
            return UploadParts(total, done, current, bars)
        }
    }
}

/**
 * Upload speed over the last 30 seconds of confirmed bytes, for the estimate under the percentage. With fewer
 * than three samples, or none moving, there is no estimate: a guess on a broken link would mislead (A2).
 */
class SpeedMeter(private val windowMs: Long = 30_000) {
    private val samples = ArrayDeque<Pair<Long, Long>>()

    fun add(atMs: Long, bytes: Long) {
        if (samples.lastOrNull()?.second == bytes) return
        if (samples.isNotEmpty() && bytes < samples.last().second) samples.clear() // a new attempt started over
        samples.addLast(atMs to bytes)
        while (samples.size > 1 && atMs - samples.first().first > windowMs) samples.removeFirst()
    }

    fun reset() = samples.clear()

    /** Seconds left for [remainingBytes], or null when the window has too little to go on. */
    fun etaSeconds(remainingBytes: Long): Long? {
        if (samples.size < 3) return null
        val (t0, b0) = samples.first()
        val (t1, b1) = samples.last()
        if (t1 <= t0 || b1 <= b0) return null
        val bytesPerMs = (b1 - b0).toDouble() / (t1 - t0)
        return ceil(remainingBytes.coerceAtLeast(0) / bytesPerMs / 1000).toLong()
    }
}
