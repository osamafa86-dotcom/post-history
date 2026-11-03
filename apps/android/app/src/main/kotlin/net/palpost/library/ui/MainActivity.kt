package net.palpost.library.ui

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import net.palpost.library.PostHistoryApp
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.notifications.NotificationLink
import net.palpost.library.core.notifications.NotificationLinks
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.ui.theme.PostHistoryTheme

class MainActivity : ComponentActivity() {
    /**
     * A notification's tap waiting to be followed (ADR 0106); AppRoot follows it once the right account is signed in, or drops
     * it. It outlives a rotation or the process stopping while the login screen shows, so the tap is followed after the sign-in.
     */
    private val pendingLink = androidx.compose.runtime.mutableStateOf<NotificationLink?>(null)

    private val container get() = (application as PostHistoryApp).container

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linkOf(intent.extras)?.let { pendingLink.value = it }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Nothing from this app shows in the recents switcher or in screenshots (reporter safety rule).
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val appContainer = container
        pendingLink.value = if (savedInstanceState == null) linkOf(intent?.extras) else linkOf(savedInstanceState.getBundle(STATE_LINK))
        setContent {
            PostHistoryTheme { AppRoot(appContainer, pendingLink.value) { pendingLink.value = null } }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        pendingLink.value?.let { link ->
            outState.putBundle(STATE_LINK, Bundle().apply { for ((k, v) in NotificationLinks.extras(link, container.settings.notificationLinkKey)) putString(k, v) })
        }
    }

    override fun onResume() {
        super.onResume()
        // Opening the app is the moment a transfer resumes after a force stop or a reboot (Android 14+).
        if (container.auth.state.value is AuthState.SignedIn) lifecycleScope.launch { UploadScheduler.resumePending(this@MainActivity) }
    }

    /** Ids and this installation's key only; anything else in the intent is ignored, and an extras bundle that cannot be read is none. */
    private fun linkOf(extras: Bundle?): NotificationLink? {
        if (extras == null) return null
        return runCatching { NotificationLinks.parse({ k -> extras.getString(k) }, container.settings.notificationLinkKey) }.getOrNull()
    }

    private companion object {
        const val STATE_LINK = "pending_notification_link"
    }
}
