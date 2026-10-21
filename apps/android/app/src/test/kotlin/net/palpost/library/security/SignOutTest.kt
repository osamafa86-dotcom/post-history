package net.palpost.library.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SignOutTest {
    @Test fun `sign-out clears shown notifications before the push registration and the session go`() = runBlocking {
        val calls = ArrayList<String>()
        SignOut({ calls += "notifications" }, { calls += "push" }, { all -> calls += "session:$all" }).run(allSessions = true)
        assertEquals(listOf("notifications", "push", "session:true"), calls)
    }

    @Test fun `notifications are cleared even when the push call fails`() = runBlocking {
        val calls = ArrayList<String>()
        runCatching { SignOut({ calls += "notifications" }, { throw IllegalStateException("offline") }, { calls += "session" }).run(false) }
        assertEquals("notifications", calls.first())
    }
}
