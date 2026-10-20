package net.palpost.library.core.upload

/**
 * Sizes each PATCH from the link as observed, so that one request ends within [targetMs] instead of running into
 * the read timeout on a slow link (at the field-weak Mathis limit a 1 MiB request needs minutes; the kernel and
 * any proxy buffer the body, the client then waits for a response that cannot arrive in time, and every request
 * is cut although the server kept its bytes).
 *
 * The rate is the bytes the server took during an attempt over that attempt's wall time: acknowledged bytes
 * for a request that ended normally, the offset `HEAD` reports for one that failed (counted up to the failure,
 * not the backoff that followed). An attempt that moved nothing (a blackout) changes nothing. The first request
 * is [maxBytes] (the session's part size); every later one stays within [minBytes, maxBytes].
 */
class RequestSizer(
    private val minBytes: Int,
    private val maxBytes: Int,
    private val targetMs: Long,
    private val clock: () -> Long,
) {
    init { require(minBytes in 1..maxBytes) { "request bounds $minBytes..$maxBytes" } }

    private var bytesPerMs: Double? = null
    private var attemptStartMs = 0L
    private var attemptStartOffset = -1L
    private var attemptFailedAtMs: Long? = null

    /** The size of the request that is about to open at [offset]; starts the attempt's clock. */
    fun begin(offset: Long): Int {
        attemptStartMs = clock()
        attemptStartOffset = offset
        attemptFailedAtMs = null
        return next()
    }

    /** The server acknowledged the open request up to [offset]. */
    fun acknowledged(offset: Long) = observe(offset, clock())

    /** The open request failed now; the server's offset is learned from the next [serverOffset]. */
    fun failed() { if (attemptStartOffset >= 0 && attemptFailedAtMs == null) attemptFailedAtMs = clock() }

    /** `HEAD` answered [offset]; closes a failed attempt with whatever the server kept of it. */
    fun serverOffset(offset: Long) { if (attemptStartOffset >= 0) observe(offset, attemptFailedAtMs ?: clock()) }

    /** What the next request would be, without starting an attempt. */
    fun next(): Int = bytesPerMs?.let { (it * targetMs).toLong().coerceIn(minBytes.toLong(), maxBytes.toLong()).toInt() } ?: maxBytes

    private fun observe(offset: Long, endMs: Long) {
        val bytes = offset - attemptStartOffset
        val ms = endMs - attemptStartMs
        if (bytes > 0 && ms > 0) bytesPerMs = bytes.toDouble() / ms
        attemptStartOffset = -1
        attemptFailedAtMs = null
    }
}
