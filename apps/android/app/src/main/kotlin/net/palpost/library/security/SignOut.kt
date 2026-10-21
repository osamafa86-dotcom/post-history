package net.palpost.library.security

/**
 * Sign-out leaves no trace on the screen: shown notifications go first (their badge with them; the app schedules
 * none), then this phone's push registration, then the session. The emergency wipe does the same in its
 * `transfers` step (`NotificationManager.cancelAll`).
 */
class SignOut(
    private val cancelShownNotifications: () -> Unit,
    private val unregisterPush: suspend () -> Unit,
    private val endSession: suspend (allSessions: Boolean) -> Unit,
) {
    suspend fun run(allSessions: Boolean) {
        cancelShownNotifications()
        unregisterPush()
        endSession(allSessions)
    }
}
