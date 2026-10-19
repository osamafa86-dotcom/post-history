package net.palpost.library.upload

import android.content.Context
import android.os.BatteryManager
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
        val engine = UploadEngine(
            store = container.uploadStore, files = container.fileSource, uploadsApi = container.uploadsApi,
            allowFullHash = { batteryAllowsHashing() },
        )
        var remaining = false
        val pending = container.uploadStore.pending()
        pending.forEachIndexed { index, task ->
            if (shouldStop()) { remaining = true; return@forEachIndexed }
            if (container.auth.state.value !is AuthState.SignedIn) { remaining = true; return@forEachIndexed }
            progress.update(index, pending.size, (task.progress * 100).toInt())
            val outcome = engine.run(task.id, shouldStop) { t: UploadTask, sent: Long ->
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

    /** The full SHA-256 is one extra read of the file: skipped on a low battery unless charging. */
    private fun batteryAllowsHashing(): Boolean {
        val bm = context.getSystemService(BatteryManager::class.java) ?: return true
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return bm.isCharging || level < 0 || level >= 20
    }
}
