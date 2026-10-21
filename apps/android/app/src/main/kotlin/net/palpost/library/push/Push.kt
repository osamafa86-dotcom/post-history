package net.palpost.library.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import net.palpost.library.AppContainer
import net.palpost.library.BuildConfig
import net.palpost.library.PostHistoryApp
import net.palpost.library.R
import net.palpost.library.api.models.PushDeviceRegistration
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.net.IdempotencyKey
import net.palpost.library.ui.MainActivity
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * FCM for the reporter's phone (contract v0.2: `PUT/DELETE /push-devices`). Firebase is initialised by hand from
 * build settings, so no google-services.json sits in this public repository; without them push is off and the
 * in-app list still works. The push token and the installation id are never logged.
 */
object Push {
    val enabled: Boolean get() = listOf(BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID).all { it.isNotBlank() }

    const val CHANNEL = "newsroom"
    private const val NOTIFICATION_BASE_ID = 3000

    fun init(context: Context) {
        if (!enabled || FirebaseApp.getApps(context).isNotEmpty()) return
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder().setApplicationId(BuildConfig.FCM_APP_ID).setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID).setGcmSenderId(BuildConfig.FCM_SENDER_ID).build(),
        )
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.notif_channel_newsroom), NotificationManager.IMPORTANCE_HIGH))
    }

    /** Registers (or refreshes) this installation's token for the signed-in user. Best effort; retried on next start. */
    suspend fun register(container: AppContainer, token: String? = null) {
        if (!enabled) return
        runCatching {
            val t = token ?: FirebaseMessaging.getInstance().token.await()
            container.notificationsApi.registerPushDevice(
                IdempotencyKey.generate(),
                PushDeviceRegistration(installationId = UUID.fromString(container.settings.installationId), platform = PushDeviceRegistration.Platform.android, token = t, appVersion = BuildConfig.VERSION_NAME),
            )
        }
    }

    /** Before sign-out or a wipe: the server forgets this phone, then the local token is dropped. Never blocks long. */
    suspend fun unregister(container: AppContainer, timeoutMs: Long = 3_000) {
        if (!enabled) return
        withTimeoutOrNull(timeoutMs) {
            runCatching { container.notificationsApi.unregisterPushDevice(IdempotencyKey.generate(), UUID.fromString(container.settings.installationId)) }
            runCatching { FirebaseMessaging.getInstance().deleteToken().await() }
        }
    }

    /**
     * The server's payload is a closed list (schemas/notification-channel-payload.json): a material number and state
     * in `title`, no names or places. It is shown inside the notification only; nothing on the lock screen.
     */
    fun show(context: Context, data: Map<String, String>) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_NOTIFICATIONS).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val urgent = data["priority"] == "urgent"
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(context.getString(if (urgent) R.string.notif_newsroom_urgent else R.string.notif_newsroom_title))
            .setContentText(data["title"]?.take(120))
            .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        val id = NOTIFICATION_BASE_ID + ((data["notification_id"]?.hashCode() ?: 0) and 0xFFF)
        NotificationManagerCompat.from(context).notify(id, n)
    }
}

class FcmService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        val container = (application as PostHistoryApp).container
        if (container.auth.state.value is AuthState.SignedIn) scope.launch { Push.register(container, token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val container = (application as PostHistoryApp).container
        // A phone that was signed out or wiped shows nothing, whatever reaches it.
        if (container.auth.state.value !is AuthState.SignedIn) return
        Push.show(this, message.data)
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnSuccessListener { cont.resume(it) }
    addOnFailureListener { cont.resumeWithException(it) }
    addOnCanceledListener { cont.cancel() }
}
