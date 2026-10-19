package net.palpost.library.upload

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import net.palpost.library.PostHistoryApp

/**
 * Android 10–13: a `dataSync` foreground service with no system time limit (the six-hour cap applies to
 * apps targeting Android 15+ running on Android 15+, where the job above is used instead). What ends it
 * early on these devices is the manufacturer's task killer, which the onboarding screen addresses.
 */
class UploadForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var work: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        UploadNotifications.ensureChannels(this)
        startForeground(UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this, 0, 0, null), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (work?.isActive == true) return START_STICKY
        val container = (application as PostHistoryApp).container
        work = scope.launch {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            UploadRunner(this@UploadForegroundService, container).runAll(shouldStop = { !isActive }) { done, total, percent ->
                if (isActive) nm.notify(UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this@UploadForegroundService, done, total, percent))
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
