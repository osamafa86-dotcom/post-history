package net.palpost.library.core.security

/**
 * One thing to erase from the device, by a stable name the result screen and the field card can show
 * ("session", "upload_queue"...). Names carry no data; they are the same on every device.
 */
class WipeStep(val name: String, val action: suspend () -> Unit)

/** What a wipe did. Kept in memory for the screen that follows; never written anywhere. */
data class WipeReport(val wiped: List<String>, val failed: List<String>) {
    val complete: Boolean get() = failed.isEmpty()
}

/**
 * Runs every step whatever happens to the others: an emergency wipe must erase as much as it can, and a
 * failure in one store (a missing file, a Keystore hiccup) must not spare the next. Steps run in the order
 * given, which the callers choose so that the most sensitive stores (tokens, queue) go first.
 */
object WipeSequence {
    suspend fun run(steps: List<WipeStep>): WipeReport {
        val wiped = ArrayList<String>()
        val failed = ArrayList<String>()
        for (step in steps) {
            try {
                step.action()
                wiped += step.name
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                throw e
            } catch (e: Exception) {
                failed += step.name
            }
        }
        return WipeReport(wiped, failed)
    }
}
