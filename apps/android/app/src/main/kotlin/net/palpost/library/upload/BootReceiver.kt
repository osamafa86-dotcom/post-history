package net.palpost.library.upload

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Android 10–13: after a reboot the foreground service resumes the queue on its own. From Android 14 a
 * `dataSync` service may not start from this broadcast and a user-initiated job needs the app on screen, so
 * there the transfer resumes when the reporter next opens the app (as the plan promises: resume from the
 * last byte that arrived, not unlimited continuation).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { UploadScheduler.resumePending(context) } finally { pending.finish() }
        }
    }
}
