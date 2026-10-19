package net.palpost.library.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import net.palpost.library.AppContainer
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason

private enum class Screen { Home, FormPreview }

@Composable
fun AppRoot(container: AppContainer) {
    val authState by container.auth.state.collectAsStateWithLifecycle()
    when (val state = authState) {
        is AuthState.SignedOut -> LoginScreen(container, sessionRevoked = state.reason == SignOutReason.SESSION_REVOKED)
        is AuthState.SignedIn -> {
            var screen by rememberSaveable { mutableStateOf(Screen.Home) }
            BackHandler(enabled = screen != Screen.Home) { screen = Screen.Home }
            when (screen) {
                Screen.Home -> HomeScreen(container, onOpenForm = { screen = Screen.FormPreview })
                Screen.FormPreview -> FormPreviewScreen(container, onBack = { screen = Screen.Home })
            }
        }
    }
}
