package net.palpost.library.upload

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import net.palpost.library.PostHistoryApp

/** Picks the host for the queue by Android release and starts it. Call from the foreground (UIDT requires it). */
object UploadScheduler {
    private const val JOB_ID = 4100

    /** Starts or re-arms the transfer host. Returns false when the system refused (nothing is lost: next open retries). */
    fun start(context: Context, remainingBytes: Long): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val info = JobInfo.Builder(JOB_ID, ComponentName(context, UploadJobService::class.java))
                .setUserInitiated(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setEstimatedNetworkBytes(remainingBytes.coerceAtLeast(1), 0)
                .build()
            context.getSystemService(JobScheduler::class.java).schedule(info) == JobScheduler.RESULT_SUCCESS
        } else {
            ContextCompat.startForegroundService(context, Intent(context, UploadForegroundService::class.java))
            true
        }
    }

    /** On app open and after boot (Android 10–13): resume whatever is pending. */
    suspend fun resumePending(context: Context): Boolean {
        val container = (context.applicationContext as PostHistoryApp).container
        val pending = container.uploadStore.pending()
        if (pending.isEmpty()) return false
        return start(context, pending.sumOf { it.sizeBytes - it.bytesConfirmed })
    }
}
