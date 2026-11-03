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
import kotlinx.coroutines.withContext
import net.palpost.library.PostHistoryApp

/**
 * Android 10–13: a `dataSync` foreground service with no system time limit (the six-hour cap applies to
 * apps targeting Android 15+ running on Android 15+, where the job above is used instead). What ends it
 * early on these devices is the manufacturer's task killer, which the onboarding screen addresses.
 */
class UploadForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var work: Job? = null
    /** A start that came while a run was going (main thread only): the run goes once more before the service stops. */
    private var again = false
    private var lastStartId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        UploadNotifications.ensureChannels(this)
        startForeground(UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this, 0, 0, null), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        lastStartId = startId
        // A send made during a run starts the service again: the run takes it (it reads the queue after every pass), and a start
        // that lands after its last read makes it go once more instead of the service stopping with the row left behind.
        if (work?.isActive == true) { again = true; return START_STICKY }
        val container = (application as PostHistoryApp).container
        work = scope.launch {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            do {
                withContext(Dispatchers.Main) { again = false }
                UploadRunner(this@UploadForegroundService, container).runAll(shouldStop = { !isActive }) { done, total, percent ->
                    if (isActive) nm.notify(UploadNotifications.PROGRESS_ID, UploadNotifications.progress(this@UploadForegroundService, done, total, percent))
                }
                // On the main thread, as onStartCommand: either a start came and the run goes again, or the service stops with no
                // start in between.
                val rerun = withContext(Dispatchers.Main) {
                    if (!again && isActive) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(lastStartId) }
                    again
                }
            } while (rerun && isActive)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
