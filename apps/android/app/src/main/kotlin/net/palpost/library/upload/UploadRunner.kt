package net.palpost.library.upload

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.upload.RunOutcome
import net.palpost.library.core.upload.UploadEngine
import net.palpost.library.core.upload.UploadState
import net.palpost.library.core.upload.UploadTask

/**
 * Works through the queue, one task at a time, for whichever host is keeping the process alive (the
 * user-initiated job on Android 14+, the foreground service before). Returns true when something is left
 * that a later run must pick up (offline, receipt pending, stopped); a row waiting for its owner is not.
 */
class UploadRunner(private val context: Context, private val container: AppContainer) {
    fun interface Progress { fun update(done: Int, total: Int, percent: Int?) }

    suspend fun runAll(shouldStop: () -> Boolean, progress: Progress): Boolean = withContext(Dispatchers.IO) {
        // The full SHA-256 is always computed: it is one read of the file, far cheaper than its upload, and it is
        // what ties the server's receipt to the bytes on this phone (security review of #52).
        // ADR 0093: an authenticated request goes in the row owner's name alone; another's row waits for its owner (not failed).
        val engine = UploadEngine(
            store = container.uploadStore, files = container.fileSource, uploadsApi = container.uploadsApi, ingestTokens = container.ingestTokens,
            mayAct = { t -> container.scope.value.owns(t.ownerAccount) },
        )
        var remaining = false
        val pending = container.uploadStore.pending()
        // A revoked or wiped session stops the transfer at the next chunk, not at the next task (SEC-01).
        // A pause, or a metered network under "Wi-Fi only", stops at the next chunk too (A2); bytes already
        // confirmed by the server stay, and the next run resumes from them.
        val settings = container.settings
        val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java)
        // A plain sign-out does not stop the transfer: it goes on with the row's own upload token (ADR 0093).
        val ended = { (container.auth.state.value as? AuthState.SignedOut)?.reason.let { it == SignOutReason.SESSION_REVOKED || it == SignOutReason.WIPED } }
        val stop = {
            shouldStop() || ended() || settings.uploadsPaused ||
                (settings.uploadOverWifiOnly && connectivity?.isActiveNetworkMetered != false)
        }
        // The notification counts the signed-in account's rows alone; another's row moves under a plain «uploading» (ADR 0093).
        val owns = { t: UploadTask -> container.scope.value.owns(t.ownerAccount) }
        val mine = pending.filter(owns)
        pending.forEach { task ->
            if (stop()) { remaining = true; return@forEach }
            val index = mine.indexOfFirst { it.id == task.id }
            val show = { percent: Int? -> if (index >= 0 && owns(task)) progress.update(index, mine.size, percent) else progress.update(-1, -1, null) }
            show((task.progress * 100).toInt())
            val outcome = engine.run(task.id, stop) { t: UploadTask, sent: Long ->
                show(if (t.sizeBytes > 0) ((sent * 100) / t.sizeBytes).toInt() else null)
            }
            val after = container.uploadStore.get(task.id)
            when (outcome) {
                RunOutcome.Finished -> if (owns(task)) when (after?.state) {
                    UploadState.VERIFIED, UploadState.DEDUPLICATED -> UploadNotifications.received(context, task.id, after.receiptNumber)
                    UploadState.FAILED -> UploadNotifications.failed(context, task.id)
                    else -> Unit
                }
                RunOutcome.Stopped, is RunOutcome.Pending -> remaining = true
                // Waits for its owner's sign-in, which resumes the queue; nothing for the system to retry before that.
                RunOutcome.AwaitingOwner -> Unit
            }
        }
        // While paused nothing is left for the system to reschedule: the reporter resumes from A2.
        remaining && !settings.uploadsPaused
    }
}
