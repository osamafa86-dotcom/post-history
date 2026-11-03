package net.palpost.library.core.upload

import kotlinx.coroutines.runBlocking
import net.palpost.library.api.apis.UploadsApi
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.FileInputStream

/** ADR 0093 on Android: rows for their owner alone, and no authenticated upload request in another account's name. */
class AccountScopeTest {
    @Test
    fun `a row belongs to its owner alone, and an earlier release's row to the sole account`() {
        val a = AccountScope(current = "a", sole = "a")
        assertTrue(a.owns("a"))
        assertFalse(a.owns("b"))
        assertTrue(a.owns(null))
        assertFalse(AccountScope(current = "a", sole = null).owns(null))
        assertFalse(AccountScope(current = null, sole = "a").owns("a"))
        assertEquals(1, a.pending(listOf("a" to true, "b" to true, "a" to false), { it.first }, { it.second }))
    }

    @Test
    fun `local ids are stable, opaque and counted`() {
        var accounts = LocalAccounts(salt = "s")
        val (afterA, idA) = accounts.register("server-a"); accounts = afterA
        assertEquals(idA, accounts.register("server-a").second)
        assertNotEquals("server-a", idA)
        assertEquals(idA, accounts.sole)
        val (afterB, idB) = accounts.register("server-b"); accounts = afterB
        assertNotEquals(idA, idB)
        assertNull(accounts.sole)
        assertEquals(AccountScope(idB, null), accounts.scope("server-b"))
        assertEquals(AccountScope(null, null), accounts.scope(null))
        val json = accounts.toJson()
        assertFalse(json.contains("server-a"))
        assertEquals(accounts, LocalAccounts.fromJson(json))
        assertNull(LocalAccounts.fromJson("{oops"))
        assertFalse(accounts.toString().contains(idA))
    }

    private val server = MockWebServer()
    private lateinit var fake: FakeTusd
    private var now = 1_700_000_000_000L
    private val store = InMemoryUploadStore()
    private lateinit var file: File

    @Before fun start() {
        server.start()
        fake = FakeTusd({ server.url("").toString().trimEnd('/') }, { now })
        server.dispatcher = fake
        file = File.createTempFile("synthetic", ".bin").apply { deleteOnExit(); writeBytes(ByteArray(40 * 1024) { (it % 251).toByte() }) }
    }

    @After fun stop() = server.shutdown()

    private fun engine(mayAct: (UploadTask) -> Boolean) = UploadEngine(
        store = store, files = { uri -> FileInputStream(File(uri)) }, uploadsApi = UploadsApi(server.url("/v1").toString().trimEnd('/')),
        transport = TusTransport(), clock = { now }, sleep = { ms -> now += ms },
        config = UploadEngine.Config(maxRequestPayloadBytes = 16 * 1024, minRequestPayloadBytes = 8 * 1024, chunkBytes = 4 * 1024, receiptPollBudgetMs = 60_000),
        mayAct = mayAct,
    )

    private suspend fun queue(owner: String?) = store.insert(
        UploadTask(id = "t1", materialId = "7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b", kind = "original", fileUri = file.absolutePath, filename = "a.bin",
            mimeType = null, sizeBytes = file.length(), idempotencyKey = "idem-1", createdAtEpochMs = now, ownerAccount = owner),
    )

    @Test
    fun `another account's row waits before creating its session, without failing or spending an attempt`() = runBlocking {
        queue(owner = "a")
        var scope = AccountScope(current = "b", sole = null)
        val e = engine { scope.owns(it.ownerAccount) }
        assertEquals(RunOutcome.AwaitingOwner, e.run("t1"))
        val waiting = store.get("t1")!!
        assertEquals(UploadState.CREATING_SESSION, waiting.state)
        assertEquals(0, waiting.attempts)
        assertNull(waiting.failure)
        assertEquals(0, fake.sessionCreates.get())
        // Its owner signs in: it carries on from where it stopped.
        scope = AccountScope(current = "a", sole = null)
        fake.sessionState = "verified"; fake.receipt = "R-1"
        assertEquals(RunOutcome.Finished, e.run("t1"))
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)
        assertEquals("a", store.get("t1")!!.ownerAccount)
    }

    @Test
    fun `after sign-out the transfer completes and only the receipt poll waits`() = runBlocking {
        queue(owner = "a")
        var signedIn = true
        val e = engine { signedIn && it.ownerAccount == "a" }
        fake.sessionState = "in_progress"
        // Sign out as soon as the bytes are confirmed: the tus transfer carries its own upload token.
        val outcome = e.run("t1", shouldStop = { false }) { _, sent -> if (sent >= file.length()) signedIn = false }
        assertEquals(RunOutcome.AwaitingOwner, outcome)
        val t = store.get("t1")!!
        assertEquals(UploadState.AWAITING_RECEIPT, t.state)
        assertEquals(file.length(), t.bytesConfirmed)
        assertNull(t.failure)
        signedIn = true
        fake.sessionState = "verified"; fake.receipt = "R-2"
        assertEquals(RunOutcome.Finished, e.run("t1"))
        assertEquals("R-2", store.get("t1")!!.receiptNumber)
    }

    @Test
    fun `nobody signed in means no authenticated request at all`() = runBlocking {
        queue(owner = null)
        val scope = AccountScope(current = null, sole = "a")
        assertEquals(RunOutcome.AwaitingOwner, engine { scope.owns(it.ownerAccount) }.run("t1"))
        assertEquals(0, fake.sessionCreates.get())
    }
}
