package net.palpost.library.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import net.palpost.library.R
import net.palpost.library.ui.MainActivity

/**
 * Progress and outcome notifications. They name no file, no title and no place: only counts, percentages
 * and the receipt number (no sensitive data in any notification, CLAUDE.md §5).
 */
object UploadNotifications {
    const val CHANNEL_PROGRESS = "uploads"
    const val CHANNEL_RESULTS = "upload_results"
    const val PROGRESS_ID = 1001
    private const val RESULT_BASE_ID = 2000

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_PROGRESS, context.getString(R.string.notif_channel_progress), NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RESULTS, context.getString(R.string.notif_channel_results), NotificationManager.IMPORTANCE_DEFAULT))
    }

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun progress(context: Context, done: Int, total: Int, percent: Int?): Notification =
        NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(context.getString(R.string.notif_progress_title))
            .setContentText(if (total == 0) context.getString(R.string.notif_progress_waiting) else context.getString(R.string.notif_progress_text, done + 1, total, percent ?: 0))
            .setProgress(100, percent ?: 0, percent == null)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setContentIntent(openApp(context))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    fun received(context: Context, taskId: String, receipt: String?) = post(
        context, taskId,
        NotificationCompat.Builder(context, CHANNEL_RESULTS)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(context.getString(R.string.notif_received_title))
            .setContentText(receipt?.let { context.getString(R.string.notif_received_text, it) } ?: context.getString(R.string.notif_received_no_receipt))
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .build(),
    )

    fun failed(context: Context, taskId: String) = post(
        context, taskId,
        NotificationCompat.Builder(context, CHANNEL_RESULTS)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(context.getString(R.string.notif_failed_title))
            .setContentText(context.getString(R.string.notif_failed_text))
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .build(),
    )

    private fun post(context: Context, taskId: String, n: Notification) {
        try {
            context.getSystemService(NotificationManager::class.java).notify(RESULT_BASE_ID + (taskId.hashCode() and 0xffff), n)
        } catch (e: SecurityException) {
            // Notifications denied: the uploads screen still shows the outcome.
        }
    }

    fun cancelProgress(context: Context) = context.getSystemService(NotificationManager::class.java).cancel(PROGRESS_ID)
}
