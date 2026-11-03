package net.palpost.library.core.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import net.palpost.library.api.apis.UploadsApi
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * ADR 0112: a cancel stops the transfer and is never undone by it, the server session goes with it, and the wipe's halt reaches a
 * transfer blocked on the network. Also the file read grant lost mid-transfer, and the host's catch-all.
 */
class UploadCancelTest {
    private val server = MockWebServer()
    private lateinit var fake: FakeTusd
    private var now = 1_700_000_000_000L
    private val store = InMemoryUploadStore()
    private val abortStore = InMemoryAbortStore()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private lateinit var file: File
    private val fileSize = 300 * 1024L + 17
    private val files = FileSource { uri -> FileInputStream(File(uri)) }
    private val config = UploadEngine.Config(maxRequestPayloadBytes = 64 * 1024, minRequestPayloadBytes = 16 * 1024, chunkBytes = 8 * 1024, receiptPollBudgetMs = 60_000)

    @Before fun start() {
        server.start()
        fake = FakeTusd({ server.url("").toString().trimEnd('/') }, { now })
        server.dispatcher = fake
        file = File.createTempFile("synthetic", ".bin").apply { deleteOnExit(); writeBytes(ByteArray(fileSize.toInt()) { (it % 251).toByte() }) }
    }

    @After fun stop() = server.shutdown()

    private fun api() = UploadsApi(server.url("/v1").toString().trimEnd('/'))

    private fun aborts(mayAct: (String?) -> Boolean = { true }) = SessionAborts(abortStore, api(), mayAct, clock = { now })

    private fun engine(
        store: UploadStore = this.store, files: FileSource = this.files, transport: TusTransport = TusTransport(), aborts: SessionAborts? = aborts(),
    ) = UploadEngine(
        store = store, files = files, uploadsApi = api(), transport = transport, clock = { now }, sleep = { ms -> now += ms }, config = config,
        isCancelled = { it in cancelled }, aborts = aborts,
    )

    private fun task() = UploadTask(
        id = "t1", materialId = "7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b", kind = "original", fileUri = file.absolutePath, filename = "clip.mov",
        mimeType = "video/quicktime", sizeBytes = fileSize, idempotencyKey = "idem-1", createdAtEpochMs = now, ownerAccount = "a",
    )

    /** A row whose session exists and whose transfer is about to start. */
    private fun uploading() = task().copy(
        state = UploadState.UPLOADING, sha256 = "0".repeat(64), sessionId = fake.sessionId, tusEndpoint = server.url("/files/").toString(),
        uploadToken = fake.token, tokenExpiresAtEpochMs = now + 3_600_000, partSizeBytes = fake.partSize,
    )

    @Test fun `a cancel mid-transfer stops at the next chunk, never writes the row back, and aborts the session on the server`() = runBlocking {
        store.insert(task())
        // The reporter's «cancel» on the uploads screen, as soon as the first bytes go: the mark, then the row's deletion.
        val outcome = engine().run("t1") { _, sent -> if (sent > 0 && cancelled.add("t1")) store.delete("t1") }
        assertEquals(RunOutcome.Finished, outcome)
        assertNull("the cancelled row is not brought back", store.get("t1"))
        assertEquals("stopped inside the first request", 1, fake.patches.get())
        assertEquals("one abort for the session", 1, fake.abortKeys.size)
        assertTrue(fake.uploads.isEmpty())
        assertTrue("nothing left to send", abortStore.all().isEmpty())
    }

    @Test fun `a row deleted under its run without the mark is not written back either, and its session is aborted`() = runBlocking {
        store.insert(task())
        val outcome = engine().run("t1") { _, sent -> if (sent > 0) store.delete("t1") }
        assertEquals(RunOutcome.Finished, outcome)
        assertNull(store.get("t1"))
        assertEquals("ended at the first acknowledged request", 1, fake.patches.get())
        assertEquals(1, fake.abortKeys.size)
    }

    @Test fun `a cancel while the session is being created still ends the session the run got`() = runBlocking {
        store.insert(task())
        // The row goes while `POST /uploads` is in flight: the run's write of the new session finds it gone.
        val racing = object : UploadStore by store {
            override suspend fun update(task: UploadTask): Boolean {
                if (task.state == UploadState.UPLOADING && task.tusUploadUrl == null) { cancelled.add(task.id); store.delete(task.id) }
                return store.update(task)
            }
        }
        assertEquals(RunOutcome.Finished, engine(store = racing).run("t1"))
        assertNull(store.get("t1"))
        assertEquals(0, fake.creates.get())
        assertEquals(1, fake.abortKeys.size)
    }

    @Test fun `an abort that cannot go now is kept with its key and sent by a later drain`() = runBlocking {
        val a = aborts()
        fake.abortStatus = 503
        a.abort(uploading())
        assertEquals(1, abortStore.all().size)
        fake.abortStatus = 204
        assertEquals(0, a.drain())
        assertEquals("the same key on the retry", 1, fake.abortKeys.distinct().size)
        assertEquals(2, fake.abortKeys.size)
        // 401 the client could not cure is kept too; a final 4xx (here 404: not this account's, or gone) drops it.
        fake.abortStatus = 401
        a.abort(uploading())
        assertEquals(1, a.drain())
        a.abort(uploading().copy(sessionId = "0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b"))
        fake.abortStatus = 204
        assertEquals(0, a.drain())
    }

    @Test fun `an abort goes in its owner's name alone and nothing is sent for a row with no session or a verified one`() = runBlocking {
        var signedIn: String? = "b"
        val a = aborts { owner -> owner == signedIn }
        a.abort(uploading())
        assertEquals(0, fake.abortKeys.size)
        assertEquals(1, abortStore.all().size)
        signedIn = "a"
        assertEquals(0, a.drain())
        assertEquals(1, fake.abortKeys.size)
        a.abort(task())
        a.abort(uploading().copy(state = UploadState.VERIFIED))
        assertEquals(1, fake.abortKeys.size)
        assertTrue(abortStore.all().isEmpty())
    }

    @Test fun `a file whose read grant went fails as unavailable instead of crashing the transfer`() = runBlocking {
        store.insert(uploading())
        val revoked = FileSource { throw SecurityException("no grant") }
        assertEquals(RunOutcome.Finished, engine(files = revoked).run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.FILE_UNAVAILABLE, t.failure)
    }

    @Test fun `what no step expects fails the row through the host's catch-all`() = runBlocking {
        store.insert(task())
        val broken = FileSource { throw IllegalStateException("provider bug") }
        val e = engine(files = broken)
        try {
            e.run("t1"); fail("the engine does not swallow what it does not expect")
        } catch (expected: IllegalStateException) {
            e.failUnexpected("t1")
        }
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.UNKNOWN, t.failure)
    }

    @Test fun `the wipe's halt cuts a transfer blocked on the network and nothing it does afterwards reaches the store`() = runBlocking {
        store.insert(task())
        fake.stallAtPatch.add(2)
        val halt = TransferHalt()
        val generation = halt.generation()
        val transport = TusTransport(readTimeoutMs = 60_000)
        val e = engine(store = halt.guard(store, generation), transport = transport, aborts = SessionAborts(halt.guard(abortStore, generation), api(), { true }))
        val run = async(Dispatchers.IO) { halt.tracking(transport) { e.run("t1", shouldStop = { !halt.isLive(generation) }) } }
        // The second request's bytes are on the server and its answer never comes: the transfer thread waits in a socket read.
        withTimeout(10_000) { while (fake.patches.get() < 2) delay(10) }
        delay(100)
        val before = store.get("t1")!!
        val started = System.nanoTime()
        halt.halt()
        assertTrue("the run returned long before its read timeout", halt.awaitIdle(5_000))
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
        assertEquals(RunOutcome.Finished, run.await())
        assertEquals("not a byte written after the halt", before, store.get("t1"))
        assertTrue(abortStore.all().isEmpty())
        assertEquals(0, fake.abortKeys.size)
        // A run of the next generation (after the wipe, a new sign-in) works as before.
        assertEquals(before, halt.guard(store, halt.generation()).get("t1"))
    }
}
