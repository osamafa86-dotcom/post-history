package net.palpost.library.core.upload

import java.io.FilterInputStream
import java.io.InputStream

/**
 * `InputStream.skip` may skip fewer bytes than asked, and some content providers do (ADR 0061). tus-java-client
 * seeks to the server's offset with a single `skip`, so a short skip would send the wrong bytes after a resume.
 * This wrapper makes every `skip` go the whole way, or to the end of the stream.
 */
class FullSkipInputStream(input: InputStream) : FilterInputStream(input) {
    override fun skip(n: Long): Long = skipFully(`in`, n)

    companion object {
        /** Skips [count] bytes, reading through when `skip` makes no progress; returns the bytes actually skipped. */
        fun skipFully(input: InputStream, count: Long): Long {
            var remaining = count
            while (remaining > 0) {
                val skipped = input.skip(remaining)
                if (skipped > 0) remaining -= skipped
                else if (input.read() < 0) break
                else remaining--
            }
            return count.coerceAtLeast(0) - remaining.coerceAtLeast(0)
        }
    }
}
