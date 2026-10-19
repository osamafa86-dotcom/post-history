package net.palpost.library.upload

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import net.palpost.library.PostHistoryApp

/**
 * Android 14+: a user-initiated data transfer job. Exempt from the job quotas Android 16 applies even to
 * work started from a foreground service, keeps running with the screen off, and shows its own notification
 * which the system detaches when the job ends.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class UploadJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var work: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val container = (application as PostHistoryApp).container
        UploadNotifications.ensureChannels(this)
        setNotification(params, UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this, 0, 0, null), JOB_END_NOTIFICATION_POLICY_DETACH)
        work = scope.launch {
            val remaining = try {
                UploadRunner(this@UploadJobService, container).runAll(shouldStop = { !isActive }) { done, total, percent ->
                    if (isActive) setNotification(params, UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this@UploadJobService, done, total, percent), JOB_END_NOTIFICATION_POLICY_DETACH)
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                return@launch
            }
            jobFinished(params, remaining)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        work?.cancel()
        return true // the system reschedules; progress is persisted per acknowledged request
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
