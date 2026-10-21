package net.palpost.library.ui

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import net.palpost.library.PostHistoryApp
import net.palpost.library.core.auth.AuthState
import net.palpost.library.upload.UploadScheduler
import net.palpost.library.ui.theme.PostHistoryTheme

class MainActivity : ComponentActivity() {
    /** A screen asked for by a notification tap; AppRoot consumes it. */
    private val openRequest = androidx.compose.runtime.mutableStateOf<String?>(null)

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        openRequest.value = intent.getStringExtra(EXTRA_OPEN)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Nothing from this app shows in the recents switcher or in screenshots (reporter safety rule).
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val container = (application as PostHistoryApp).container
        if (savedInstanceState == null) openRequest.value = intent?.getStringExtra(EXTRA_OPEN)
        setContent {
            PostHistoryTheme { AppRoot(container, openRequest.value) { openRequest.value = null } }
        }
    }

    override fun onResume() {
        super.onResume()
        // Opening the app is the moment a transfer resumes after a force stop or a reboot (Android 14+).
        val container = (application as PostHistoryApp).container
        if (container.auth.state.value is AuthState.SignedIn) lifecycleScope.launch { UploadScheduler.resumePending(this@MainActivity) }
    }

    companion object {
        const val EXTRA_OPEN = "open"
        const val OPEN_NOTIFICATIONS = "notifications"
    }
}
