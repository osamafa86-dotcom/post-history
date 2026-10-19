package net.palpost.library.ui

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import net.palpost.library.PostHistoryApp
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
}
