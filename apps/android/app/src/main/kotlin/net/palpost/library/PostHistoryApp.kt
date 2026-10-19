package net.palpost.library

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.auth.SignOutReason
import net.palpost.library.core.security.WipeReport
import net.palpost.library.security.DeviceWipe

class PostHistoryApp : Application() {
    lateinit var container: AppContainer
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** The last wipe's outcome, for the screen that follows it; memory only. */
    private val _lastWipe = MutableStateFlow<WipeReport?>(null)
    val lastWipe: StateFlow<WipeReport?> = _lastWipe

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // SEC-01: a session the server revoked (401 on refresh) takes the device's upload state with it.
        scope.launch {
            container.auth.state.collect { state ->
                if (state is AuthState.SignedOut && state.reason == SignOutReason.SESSION_REVOKED && _lastWipe.value == null) {
                    _lastWipe.value = DeviceWipe(this@PostHistoryApp, container).afterRevocation()
                }
            }
        }
    }

    suspend fun emergencyWipe(): WipeReport = DeviceWipe(this, container).emergency().also { _lastWipe.value = it }

    fun acknowledgeWipe() { _lastWipe.value = null }
}
