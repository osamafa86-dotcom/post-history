package net.palpost.library

import net.palpost.library.push.Push
import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import net.palpost.library.upload.UploadScheduler
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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

    /** One wipe at a time: an emergency wipe that meets a 401 must not start a second, parallel wipe. */
    private val wipeLock = Mutex()
    @Volatile private var wipeRunning = false

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Push.init(this)
        // SEC-01: a session the server revoked (401 on refresh) takes the device's upload state with it.
        scope.launch {
            var signedInBefore: Boolean? = null
            container.auth.state.collect { state ->
                // ADR 0093: the scope first, so the queue asks in its owner's name alone and the screens show the owner's rows alone.
                container.updateScope(state)
                if (state is AuthState.SignedIn) {
                    Push.register(container)
                    container.receipts.signedIn()
                    // A sign-in (not the session found at launch, which the activity resumes): what waited for this account goes on now.
                    if (signedInBefore == false) runCatching { UploadScheduler.resumePending(this@PostHistoryApp) }
                } else {
                    // Nothing of the reporter who left stays on screen or in memory: players, the list, thumbnails.
                    container.playback.stopAll()
                    container.materials.clear()
                    container.thumbnails.clear()
                }
                signedInBefore = state is AuthState.SignedIn
                if (state is AuthState.SignedOut && state.reason == SignOutReason.SESSION_REVOKED && _lastWipe.value == null && !wipeRunning) {
                    wipeLock.withLock { if (_lastWipe.value == null) _lastWipe.value = DeviceWipe(this@PostHistoryApp, container).afterRevocation() }
                }
            }
        }
    }

    suspend fun emergencyWipe(): WipeReport = wipeLock.withLock {
        wipeRunning = true
        try { DeviceWipe(this, container).emergency().also { _lastWipe.value = it } } finally { wipeRunning = false }
    }

    fun acknowledgeWipe() { _lastWipe.value = null }
}
