package net.palpost.library.security

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.Dispatchers
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
 *  - transfers: scheduled job / foreground service stopped, progress and result notifications cancelled
 *  - session: Keystore-sealed tokens removed from the `session` preferences, the Keystore key destroyed
 *  - upload_queue: every Room table cleared, then the database files deleted (`uploads.db`, `-wal`, `-shm`)
 *  - file_grants: persistable read grants on picked originals released (the originals themselves belong to the
 *    reporter and are deleted only through the explicit per-file choice)
 *  - preferences: every SharedPreferences file (setup flags included)
 *  - caches_and_files: internal cache, code cache, files, no-backup files and external caches (this app writes
 *    no copies, proxies or thumbnails there today; cleared anyway so nothing added later survives a wipe)
 */
class DeviceWipe(private val context: Context, private val container: AppContainer) {
    val targets: List<String> get() = steps(SignOutReason.WIPED).map { it.name }

    /**
     * Emergency: first a best-effort request to end every session on the server (at most three seconds,
     * ignored if offline or refused), then the local erase, which never waits for or depends on that answer.
     */
    suspend fun emergency(): WipeReport {
        val serverRevoked = container.auth.revokeAllSessionsBestEffort(timeoutMs = 3_000)
        val local = run(SignOutReason.WIPED)
        return if (serverRevoked) local.copy(wiped = listOf("server_sessions") + local.wiped) else local
    }

    /** After a 401 on refresh the tokens are already gone; everything else goes now. */
    suspend fun afterRevocation(): WipeReport = run(SignOutReason.SESSION_REVOKED)

    private suspend fun run(reason: SignOutReason): WipeReport = withContext(Dispatchers.IO) { WipeSequence.run(steps(reason)) }

    private fun steps(reason: SignOutReason): List<WipeStep> = listOf(
        WipeStep("transfers") {
            UploadScheduler.cancel(context)
            context.stopService(Intent(context, UploadForegroundService::class.java))
            context.getSystemService(NotificationManager::class.java)?.cancelAll()
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
