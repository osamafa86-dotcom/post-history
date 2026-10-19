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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Nothing from this app shows in the recents switcher or in screenshots (reporter safety rule).
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val container = (application as PostHistoryApp).container
        setContent {
            PostHistoryTheme { AppRoot(container) }
        }
    }

    override fun onResume() {
        super.onResume()
        // Opening the app is the moment a transfer resumes after a force stop or a reboot (Android 14+).
        val container = (application as PostHistoryApp).container
        if (container.auth.state.value is AuthState.SignedIn) lifecycleScope.launch { UploadScheduler.resumePending(this@MainActivity) }
    }
}
