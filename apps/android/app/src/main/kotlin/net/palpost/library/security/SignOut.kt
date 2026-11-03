package net.palpost.library.security

/**
 * Sign-out leaves no trace on the screen: shown notifications go first (their badge with them; the app schedules
 * none), then what the app remembers for this reporter (the place and tags of earlier sends, and the sends file with
 * their titles and sensitivity answers, ADR 0088 and 0089 §6), then this phone's push registration, then the session.
 * The emergency wipe does the same in its `transfers` and `caches_and_files` steps. The upload queue is not touched:
 * an unfinished upload carries on after sign-out.
 */
class SignOut(
    private val cancelShownNotifications: () -> Unit,
    private val unregisterPush: suspend () -> Unit,
    private val endSession: suspend (allSessions: Boolean) -> Unit,
    private val forgetReporter: suspend () -> Unit = {},
) {
    suspend fun run(allSessions: Boolean) {
        cancelShownNotifications()
        runCatching { forgetReporter() }
        unregisterPush()
        endSession(allSessions)
    }
}
