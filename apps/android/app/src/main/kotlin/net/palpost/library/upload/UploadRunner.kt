package net.palpost.library.upload

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.upload.RunOutcome
import net.palpost.library.core.upload.UploadEngine
import net.palpost.library.core.upload.UploadState
import net.palpost.library.core.upload.UploadTask

/**
 * Works through the queue, one task at a time, for whichever host is keeping the process alive (the
 * user-initiated job on Android 14+, the foreground service before). Returns true when something is left
 * that a later run must pick up (offline, receipt pending, stopped).
 */
class UploadRunner(private val context: Context, private val container: AppContainer) {
    fun interface Progress { fun update(done: Int, total: Int, percent: Int?) }

    suspend fun runAll(shouldStop: () -> Boolean, progress: Progress): Boolean = withContext(Dispatchers.IO) {
        // The full SHA-256 is always computed: it is one read of the file, far cheaper than its upload, and it is
        // what ties the server's receipt to the bytes on this phone (security review of #52).
        val engine = UploadEngine(store = container.uploadStore, files = container.fileSource, uploadsApi = container.uploadsApi)
        var remaining = false
        val pending = container.uploadStore.pending()
        // A revoked or wiped session stops the transfer at the next chunk, not at the next task (SEC-01).
        val stop = { shouldStop() || container.auth.state.value !is AuthState.SignedIn }
        pending.forEachIndexed { index, task ->
            if (stop()) { remaining = true; return@forEachIndexed }
            progress.update(index, pending.size, (task.progress * 100).toInt())
            val outcome = engine.run(task.id, stop) { t: UploadTask, sent: Long ->
                progress.update(index, pending.size, if (t.sizeBytes > 0) ((sent * 100) / t.sizeBytes).toInt() else null)
            }
            val after = container.uploadStore.get(task.id)
            when (outcome) {
                RunOutcome.Finished -> when (after?.state) {
                    UploadState.VERIFIED, UploadState.DEDUPLICATED -> UploadNotifications.received(context, task.id, after.receiptNumber)
                    UploadState.FAILED -> UploadNotifications.failed(context, task.id)
                    else -> Unit
                }
                RunOutcome.Stopped, is RunOutcome.Pending -> remaining = true
            }
        }
        remaining
    }
}
