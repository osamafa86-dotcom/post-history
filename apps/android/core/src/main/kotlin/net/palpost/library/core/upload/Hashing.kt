package net.palpost.library.core.upload

import java.io.InputStream
import java.security.MessageDigest

data class FileDigests(val sha256: String?, val headSha256: String, val tailSha256: String)

/** Streaming digests: the whole file (optional, battery permitting) and the first and last MiB for dedup triage. */
object Hashing {
    const val EDGE_BYTES = 1L shl 20

    fun digests(source: FileSource, uri: String, sizeBytes: Long, full: Boolean, isCancelled: () -> Boolean = { false }): FileDigests {
        val whole = if (full) MessageDigest.getInstance("SHA-256") else null
        val head = MessageDigest.getInstance("SHA-256")
        val tail = MessageDigest.getInstance("SHA-256")
        val tailStart = maxOf(0L, sizeBytes - EDGE_BYTES)
        source.open(uri).use { input ->
            val buffer = ByteArray(256 * 1024)
            var position = 0L
            if (whole == null && sizeBytes > 2 * EDGE_BYTES) {
                // Head only, then jump to the tail: no need to read the middle.
                position = readInto(input, buffer, EDGE_BYTES, position) { b, n -> head.update(b, 0, n) }
                FullSkipInputStream.skipFully(input, tailStart - position)
                position = tailStart
                readInto(input, buffer, sizeBytes - tailStart, position) { b, n -> tail.update(b, 0, n) }
            } else {
                while (true) {
                    if (isCancelled()) throw InterruptedHashException()
                    val n = input.read(buffer)
                    if (n < 0) break
                    whole?.update(buffer, 0, n)
                    val headRemaining = (EDGE_BYTES - position).coerceIn(0, n.toLong()).toInt()
                    if (headRemaining > 0) head.update(buffer, 0, headRemaining)
                    val tailFrom = (tailStart - position).coerceIn(0, n.toLong()).toInt()
                    if (tailFrom < n) tail.update(buffer, tailFrom, n - tailFrom)
                    position += n
                }
            }
        }
        return FileDigests(whole?.let { hex(it.digest()) }, hex(head.digest()), hex(tail.digest()))
    }

    private inline fun readInto(input: InputStream, buffer: ByteArray, count: Long, start: Long, sink: (ByteArray, Int) -> Unit): Long {
        var remaining = count
        var position = start
        while (remaining > 0) {
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (n < 0) break
            sink(buffer, n)
            remaining -= n
            position += n
        }
        return position
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    class InterruptedHashException : java.io.IOException("hashing cancelled")
}
