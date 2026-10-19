package net.palpost.library.core.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WipeSequenceTest {
    @Test fun `every step runs even when one fails, in order`() = runBlocking {
        val order = ArrayList<String>()
        val report = WipeSequence.run(
            listOf(
                WipeStep("session") { order += "session" },
                WipeStep("upload_queue") { order += "upload_queue"; error("database locked") },
                WipeStep("caches") { order += "caches" },
            ),
        )
        assertEquals(listOf("session", "upload_queue", "caches"), order)
        assertEquals(listOf("session", "caches"), report.wiped)
        assertEquals(listOf("upload_queue"), report.failed)
        assertFalse(report.complete)
    }

    @Test fun `a clean run is complete`() = runBlocking {
        val report = WipeSequence.run(listOf(WipeStep("a") {}, WipeStep("b") {}))
        assertTrue(report.complete)
        assertEquals(listOf("a", "b"), report.wiped)
    }

    @Test fun `cancellation is not swallowed`() {
        var reachedSecond = false
        try {
            runBlocking {
                WipeSequence.run(listOf(WipeStep("a") { throw kotlinx.coroutines.CancellationException("stop") }, WipeStep("b") { reachedSecond = true }))
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            // expected
        }
        assertFalse(reachedSecond)
    }
}
