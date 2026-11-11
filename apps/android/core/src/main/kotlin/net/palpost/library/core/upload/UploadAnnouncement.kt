package net.palpost.library.core.upload

/**
 * What a screen reader is told about an upload row. A row is announced when it turns failed, paused or arrived, and never for
 * progress: the row's status word is a polite live region only in these three states, so a percentage that changes says nothing.
 * The order is the row's own: an arrived file is arrived even if it was paused, and a failure outranks a pause.
 */
enum class UploadAnnouncement {
    ARRIVED, FAILED, PAUSED;

    companion object {
        fun of(done: Boolean, failed: Boolean, paused: Boolean): UploadAnnouncement? = when {
            done -> ARRIVED
            failed -> FAILED
            paused -> PAUSED
            else -> null
        }
    }
}
