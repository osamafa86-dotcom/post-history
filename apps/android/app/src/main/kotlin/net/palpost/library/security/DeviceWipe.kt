package net.palpost.library.security

import net.palpost.library.push.Push
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import net.palpost.library.AppContainer
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.security.WipeReport
import net.palpost.library.core.security.WipeSequence
import net.palpost.library.core.security.WipeStep
import net.palpost.library.upload.UploadForegroundService
import net.palpost.library.upload.UploadScheduler
import java.io.File

/**
 * SEC-01, device side. Erases everything this app holds on the phone, most sensitive first, and runs every
 * step even if one fails (see WipeSequence). The same list serves the emergency wipe the reporter triggers
 * and the automatic wipe after the server revokes the session. Nothing here logs anything.
 *
 * Stores the app owns and what happens to each (plus, for the emergency path only, `server_sessions`: every
 * session of the user ended on the server when the request got through in time):
 *  - transfers: the running transfer halted first (ADR 0112: its open connection cut, so a thread blocked in a socket call returns
 *    now, and nothing it does afterwards reaches the database), scheduled job / foreground service stopped, the run awaited (bounded),
 *    progress and result notifications cancelled, the players stopped and the list of My materials with its thumbnails dropped from
 *    memory (ADR 0089)
 *  - session: Keystore-sealed tokens removed from the `session` preferences, the Keystore key destroyed
 *  - upload_queue: every Room table cleared (the queue, the drafts with the sealed filming location of a send that stopped
 *    part-way, ADR 0087, and the cancelled sessions kept for their abort, ADR 0112), then the database files deleted
 *    (`uploads.db`, `-wal`, `-shm`); the accounts record in memory with it and its `local-accounts` file (ADR 0093)
 *  - reporter_memory: the sends ledger and its file (titles, sensitivity answers), the remembered place and tags, and the
 *    receipts waiting to show or waiting for their owner, in memory and on disk (ADR 0088, 0093)
 *  - file_grants: persistable read grants on picked originals released (the originals themselves belong to the
 *    reporter and are deleted only through the explicit per-file choice)
 *  - preferences: every SharedPreferences file (setup flags included)
 *  - caches_and_files: internal cache, code cache, files, no-backup files and external caches (the last office
 *    form saved for offline use, and the receipt image last shared from A3; no copies of originals)
 */
class DeviceWipe(private val context: Context, private val container: AppContainer) {
    val targets: List<String> get() = steps(SignOutReason.WIPED).map { it.name }

    private companion object {
        /** Long enough for a cut connection's call to return; short enough that the wipe is not felt waiting. */
        const val TRANSFER_STOP_WAIT_MS = 3_000L
    }

    /**
     * Emergency: the local erase starts at once; in parallel, a best-effort request asks the server to end every
     * session (at most three seconds, ignored if offline or refused). The token for that request is read before
     * the first local step, so neither waits for the other.
     */
    suspend fun emergency(): WipeReport = coroutineScope {
        val server = async { container.auth.revokeAllSessionsBestEffort(timeoutMs = 3_000) }
        val push = async { Push.unregister(container, timeoutMs = 3_000) } // best effort, like the revocation
        val local = run(SignOutReason.WIPED)
        push.await()
        if (server.await()) local.copy(wiped = listOf("server_sessions") + local.wiped) else local
    }

    /** After a 401 on refresh the tokens are already gone; everything else goes now. */
    suspend fun afterRevocation(): WipeReport = run(SignOutReason.SESSION_REVOKED)

    private suspend fun run(reason: SignOutReason): WipeReport = withContext(Dispatchers.IO) { WipeSequence.run(steps(reason)) }

    private fun steps(reason: SignOutReason): List<WipeStep> = listOf(
        WipeStep("transfers") {
            // Coroutine cancellation does not reach a thread blocked in an HttpURLConnection call: the halt cuts its connection and
            // ends the generation its stores were opened in, so a run that returns late writes nothing into the erased queue.
            container.halt.halt()
            UploadScheduler.cancel(context)
            context.stopService(Intent(context, UploadForegroundService::class.java))
            val notifications = context.getSystemService(NotificationManager::class.java)
            notifications?.cancelAll()
            // What is on screen goes first (ADR 0089): the players, the list of My materials and its thumbnails in memory.
            container.playback.stopAll()
            container.materials.clear()
            container.thumbnails.clear()
            // The run returns before the queue is erased; one that outlives the wait still writes nothing (the guards hold).
            container.halt.awaitIdle(TRANSFER_STOP_WAIT_MS)
            container.cancelledUploads.clear()
            notifications?.cancelAll()
        },
        WipeStep("session") {
            container.auth.forgetSession(reason)
            container.sealer.destroyKey()
        },
        WipeStep("upload_queue") {
            val db = container.database
            db.clearAllTables()
            db.close()
            for (suffix in listOf("", "-wal", "-shm", "-journal")) context.getDatabasePath("uploads.db$suffix").delete()
            // The accounts record and its file go with the queue (ADR 0093 §7).
            container.forgetAccounts()
        },
        WipeStep("reporter_memory") {
            container.receipts.clear()
            container.sendBatches.forgetAll()
            container.reporterMemory.clear()
        },
        WipeStep("file_grants") {
            val resolver = context.contentResolver
            for (p in resolver.persistedUriPermissions) {
                runCatching { resolver.releasePersistableUriPermission(p.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            }
        },
        WipeStep("preferences") {
            val prefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
            prefsDir.listFiles()?.forEach { f ->
                context.getSharedPreferences(f.nameWithoutExtension, Context.MODE_PRIVATE).edit().clear().commit()
                f.delete()
            }
        },
        WipeStep("caches_and_files") {
            listOfNotNull(context.cacheDir, context.codeCacheDir, context.filesDir, context.noBackupFilesDir)
                .plus(context.externalCacheDirs.filterNotNull())
                .forEach { dir -> dir.listFiles()?.forEach { it.deleteRecursively() } }
        },
    )
}
