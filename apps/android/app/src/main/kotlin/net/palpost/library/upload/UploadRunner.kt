package net.palpost.library.upload

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.upload.RunOutcome
import net.palpost.library.core.upload.TusTransport
import net.palpost.library.core.upload.UploadEngine
import net.palpost.library.core.upload.UploadState
import net.palpost.library.core.upload.UploadTask
import kotlin.coroutines.cancellation.CancellationException

/**
 * Works through the queue, one task at a time, for whichever host is keeping the process alive (the
 * user-initiated job on Android 14+, the foreground service before). Returns true when something is left
 * that a later run must pick up (offline, receipt pending, stopped); a row waiting for its owner is not.
 */
class UploadRunner(private val context: Context, private val container: AppContainer) {
    fun interface Progress { fun update(done: Int, total: Int, percent: Int?) }

    suspend fun runAll(shouldStop: () -> Boolean, progress: Progress): Boolean = withContext(Dispatchers.IO) {
        // SEC-01 (ADR 0112): the run's stores are guarded by the generation it starts in, and its transport is tracked, so a wipe
        // cuts the connection of a thread blocked in a socket call and nothing the run does afterwards reaches the database.
        val halt = container.halt
        val generation = halt.generation()
        val store = halt.guard(container.uploadStore, generation)
        val aborts = container.sessionAborts(halt.guard(container.abortStore, generation))
        val transport = TusTransport()
        halt.tracking(transport) {
            // Cancelled sessions an earlier try could not end on the server go first (ADR 0112).
            aborts.drain()
            // The full SHA-256 is always computed: it is one read of the file, far cheaper than its upload, and it is
            // what ties the server's receipt to the bytes on this phone (security review of #52).
            // ADR 0093: an authenticated request goes in the row owner's name alone; another's row waits for its owner (not failed).
            val engine = UploadEngine(
                store = store, files = container.fileSource, uploadsApi = container.uploadsApi, transport = transport, ingestTokens = container.ingestTokens,
                mayAct = { t -> container.scope.value.owns(t.ownerAccount) },
                isCancelled = { id -> id in container.cancelledUploads }, aborts = aborts,
            )
            // A revoked or wiped session stops the transfer at the next chunk, not at the next task (SEC-01).
            // A pause, or a metered network under "Wi-Fi only", stops at the next chunk too (A2); bytes already
            // confirmed by the server stay, and the next run resumes from them.
            val settings = container.settings
            val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java)
            // A plain sign-out does not stop the transfer: it goes on with the row's own upload token (ADR 0093).
            val ended = { (container.auth.state.value as? AuthState.SignedOut)?.reason.let { it == SignOutReason.SESSION_REVOKED || it == SignOutReason.WIPED } }
            val stop = {
                shouldStop() || !halt.isLive(generation) || ended() || settings.uploadsPaused ||
                    (settings.uploadOverWifiOnly && connectivity?.isActiveNetworkMetered != false)
            }
            // The notification counts the signed-in account's rows alone; another's row moves under a plain «uploading» (ADR 0093).
            val owns = { t: UploadTask -> container.scope.value.owns(t.ownerAccount) }
            var remaining = false
            var stopped = false
            val tried = HashSet<String>()
            var mineDone = 0
            // The queue is read again after every pass: a send made while this run goes (on Android 10–13 its start finds the service
            // running and begins no run of its own) is taken here, not left for the next launch. Each row is tried once per run.
            while (!stopped) {
                val pending = store.pending().filter { it.id !in tried }
                if (pending.isEmpty()) break
                val mine = pending.filter(owns)
                for (task in pending) {
                    if (stop()) { remaining = true; stopped = true; break }
                    tried += task.id
                    val index = mine.indexOfFirst { it.id == task.id }
                    val show = { percent: Int? -> if (index >= 0 && owns(task)) progress.update(mineDone + index, mineDone + mine.size, percent) else progress.update(-1, -1, null) }
                    show((task.progress * 100).toInt())
                    val outcome = try {
                        engine.run(task.id, stop) { t: UploadTask, sent: Long ->
                            show(if (t.sizeBytes > 0) ((sent * 100) / t.sizeBytes).toInt() else null)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // What no step expects (a provider's runtime error, a bug) fails this row, which the reporter can retry, instead
                        // of taking the process down, and with it every later launch that resumes the queue.
                        try { engine.failUnexpected(task.id) } catch (c: CancellationException) { throw c } catch (ignored: Exception) { /* storage gone too: the next run sees the row again */ }
                        RunOutcome.Finished
                    }
                    val after = store.get(task.id)
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
                mineDone += mine.size
            }
            // While paused nothing is left for the system to reschedule: the reporter resumes from A2.
            remaining && !settings.uploadsPaused
        }
    }
}
