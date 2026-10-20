package net.palpost.library.core.upload

import kotlinx.coroutines.runBlocking
import net.palpost.library.api.apis.UploadsApi
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

class UploadEngineTest {
    private val server = MockWebServer()
    private lateinit var fake: FakeTusd
    private var now = 1_700_000_000_000L
    private val store = InMemoryUploadStore()
    private val sleeps = ArrayList<Long>()
    private lateinit var file: File
    private lateinit var fileSha: String
    private val files = FileSource { uri -> FileInputStream(File(uri)) }
    private val fileSize = 300 * 1024L + 17

    @Before fun start() {
        server.start()
        fake = FakeTusd({ server.url("").toString().trimEnd('/') }, { now })
        server.dispatcher = fake
        file = File.createTempFile("synthetic", ".bin").apply { deleteOnExit() }
        val rnd = java.util.Random(42)
        val bytes = ByteArray(fileSize.toInt()).also { rnd.nextBytes(it) }
        file.writeBytes(bytes)
        fileSha = Hashing.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }

    @After fun stop() = server.shutdown()

    private fun engine(config: UploadEngine.Config = testConfig) = UploadEngine(
        store = store, files = files, uploadsApi = UploadsApi(server.url("/v1").toString().trimEnd('/')), transport = TusTransport(),
        clock = { now }, sleep = { ms -> sleeps.add(ms); now += ms }, config = config,
    )

    private val testConfig = UploadEngine.Config(maxRequestPayloadBytes = 64 * 1024, minRequestPayloadBytes = 16 * 1024, chunkBytes = 8 * 1024, receiptPollBudgetMs = 60_000)

    private suspend fun queue(): UploadTask {
        val t = UploadTask(id = "t1", materialId = "7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b", kind = "original", fileUri = file.absolutePath, filename = "clip.mov", mimeType = "video/quicktime", sizeBytes = fileSize, idempotencyKey = "idem-1", createdAtEpochMs = now)
        store.save(t); return t
    }

    private fun serverBytesSha(): String = Hashing.hex(MessageDigest.getInstance("SHA-256").digest(fake.uploads.values.single().toByteArray()))

    @Test fun `happy path hashes, creates one session, uploads in parts and reads the receipt`() = runBlocking {
        queue()
        fake.receipt = "R-202610-000042"
        // The receipt appears on the second poll.
        var polls = 0
        val api = UploadsApi(server.url("/v1").toString().trimEnd('/'))
        val e = UploadEngine(store, files, api, TusTransport(), { now }, { ms -> sleeps.add(ms); now += ms; fake.sessionState = if (++polls >= 1) "verified" else "in_progress" }, testConfig)
        assertEquals(RunOutcome.Finished, e.run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.VERIFIED, t.state)
        assertEquals("R-202610-000042", t.receiptNumber)
        assertEquals(fileSha, t.sha256)
        assertEquals(fileSha, serverBytesSha())
        assertEquals(1, fake.sessionCreates.get())
        assertEquals(listOf("idem-1"), fake.sessionCreateIdempotencyKeys)
        assertEquals(1, fake.creates.get())
        assertEquals(5, fake.patches.get()) // 300 KiB + 17 B in 64 KiB requests
        assertTrue(fake.authorizations.all { it == "Bearer upload-token-1" })
        assertEquals(fileSize, t.bytesConfirmed)
    }

    @Test fun `a connection cut mid-request resumes from the server offset, never from zero`() = runBlocking {
        queue()
        fake.cutAtPatch.add(2)
        fake.sessionState = "verified"; fake.receipt = "R-202610-000001"
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        assertEquals(fileSha, serverBytesSha())
        assertEquals(1, fake.creates.get())
        val offsets = fake.log.filter { it.startsWith("PATCH") }.size
        assertTrue("retried after the cut", offsets >= 6)
        // After the cut the client asked HEAD and continued from exactly what was stored (half of request 2).
        assertTrue(fake.heads.get() >= 2)
        assertEquals(listOf(2_000L), sleeps.filter { it == 2_000L }.take(1))
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)
    }

    @Test fun `a link that cuts every request still moves because the server's partial bytes count and the wait stays short`() = runBlocking {
        // field-weak in netlab: no PATCH ends normally for a long stretch, yet HEAD shows the server keeping the
        // first half of each one. The engine must credit that as progress (persisted, backoff from the shortest)
        // instead of climbing to 60 s waits while the link is alive.
        queue()
        fake.cutAtPatch.addAll(1..6)
        fake.sessionState = "verified"; fake.receipt = "R-202610-000004"
        val confirmedSeen = ArrayList<Long>()
        val watching = object : UploadStore by store {
            override suspend fun save(task: UploadTask) { confirmedSeen.add(task.bytesConfirmed); store.save(task) }
        }
        val e = UploadEngine(watching, files, UploadsApi(server.url("/v1").toString().trimEnd('/')), TusTransport(), { now }, { ms -> sleeps.add(ms); now += ms }, testConfig)
        assertEquals(RunOutcome.Finished, e.run("t1"))
        assertEquals(fileSha, serverBytesSha())
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)
        assertEquals("six cuts, each followed by a HEAD that found progress", List(6) { 2_000L }, sleeps.filter { it in testConfig.backoffMs })
        // Progress was persisted from HEAD before any request was acknowledged: 32 KiB after the first cut.
        assertEquals(32 * 1024L, confirmedSeen.first { it > 0 })
        assertEquals(0, fake.uploads.values.single().size() - fileSize.toInt())
    }

    @Test fun `a 5xx from the upload server is retried with backoff`() = runBlocking {
        queue()
        fake.serverErrorAtPatch.addAll(listOf(1, 2))
        fake.sessionState = "verified"
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        assertEquals(fileSha, serverBytesSha())
        assertEquals(listOf(2_000L, 5_000L), sleeps.take(2))
    }

    @Test fun `after a kill the next run resumes from the last confirmed byte with the same session`() = runBlocking {
        queue()
        // Run 1 stops as soon as the first request is acknowledged (the host was killed right after).
        val stop = AtomicBoolean(false)
        val firstConfirmed = AtomicBoolean(false)
        val e1 = UploadEngine(store, files, UploadsApi(server.url("/v1").toString().trimEnd('/')), object : TusTransport() {
            override fun upload(uploadUrl: String, token: String, sizeBytes: Long, openStream: () -> java.io.InputStream, requestPayloadBytes: (Long) -> Int, chunkBytes: Int, shouldStop: () -> Boolean, onHead: (Long) -> Unit, onConfirmed: (Long) -> Unit, onSent: (Long) -> Unit): Long =
                super.upload(uploadUrl, token, sizeBytes, openStream, requestPayloadBytes, chunkBytes, shouldStop, onHead, { off -> onConfirmed(off); if (!firstConfirmed.getAndSet(true)) stop.set(true) }, onSent)
        }, { now }, { ms -> now += ms }, testConfig)
        assertEquals(RunOutcome.Stopped, e1.run("t1", shouldStop = { stop.get() }))
        val afterKill = store.get("t1")!!
        assertEquals(UploadState.UPLOADING, afterKill.state)
        assertTrue(afterKill.bytesConfirmed > 0 && afterKill.bytesConfirmed < fileSize)
        val storedAtKill = fake.uploads.values.single().size().toLong()
        assertTrue("persisted offset never exceeds what the server has", afterKill.bytesConfirmed <= storedAtKill)
        val logBefore = fake.log.size

        // Run 2: a fresh engine (new process) with the same store.
        fake.sessionState = "verified"; fake.receipt = "R-202610-000002"
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        val after = fake.log.drop(logBefore)
        assertEquals("HEAD /files/${fake.sessionId}", after.first { it.startsWith("HEAD") || it.startsWith("POST /files") || it.startsWith("PATCH") })
        assertEquals(1, fake.sessionCreates.get())
        assertEquals(1, fake.creates.get())
        assertEquals(fileSha, serverBytesSha())
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)
    }

    @Test fun `a lost create response is recovered through the deterministic upload url, never a second creation`() = runBlocking {
        queue()
        fake.loseCreateResponseAt.add(1)
        fake.sessionState = "verified"; fake.receipt = "R-202610-000003"
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        assertEquals(2, fake.creates.get()) // the lost one, then the retry the server answers with 403
        assertEquals(1, fake.uploads.size)
        assertEquals("HEAD /files/${fake.sessionId}", fake.log.first { it.startsWith("HEAD") })
        assertEquals(fileSha, serverBytesSha())
        val t = store.get("t1")!!
        assertEquals(UploadState.VERIFIED, t.state)
        assertEquals(server.url("/files/${fake.sessionId}").toString(), t.tusUploadUrl)
    }

    @Test fun `a 403 on creation with no upload behind it is terminal`() = runBlocking {
        queue()
        fake.rejectCreate = true
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.SESSION_EXPIRED, t.failure)
        assertEquals(listOf("POST /files/", "HEAD /files/${fake.sessionId}"), fake.log.filter { it.contains("/files") })
        assertEquals(0, fake.patches.get())
    }

    @Test fun `a lapsed upload token is a terminal failure, not a loop`() = runBlocking {
        // Queued, session created, then the phone sat in a drawer past the token's life before any byte left.
        store.save(queue().copy(state = UploadState.UPLOADING, sessionId = fake.sessionId, tusEndpoint = server.url("/files/").toString(), uploadToken = "upload-token-1", tokenExpiresAtEpochMs = now - 1, partSizeBytes = fake.partSize))
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.SESSION_EXPIRED, t.failure)
        assertEquals(0, fake.creates.get())
        assertEquals(0, fake.patches.get())
    }

    @Test fun `a checksum mismatch reported by the server fails the task with its reason`() = runBlocking {
        queue()
        fake.sessionState = "failed"; fake.failureReason = "checksum_mismatch"
        assertEquals(RunOutcome.Finished, engine().run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.CHECKSUM_MISMATCH, t.failure)
        assertNull(t.receiptNumber)
    }

    @Test fun `a receipt that is late hands back pending with the bytes safely on the server`() = runBlocking {
        queue()
        fake.sessionState = "completed"
        val outcome = engine().run("t1")
        assertTrue(outcome is RunOutcome.Pending)
        val t = store.get("t1")!!
        assertEquals(UploadState.AWAITING_RECEIPT, t.state)
        assertEquals(fileSize, t.bytesConfirmed)
        assertEquals(fileSha, serverBytesSha())
    }

    @Test fun `digests cover the whole file and its two edges`() {
        val d = Hashing.digests(files, file.absolutePath, fileSize, full = true)
        val quick = Hashing.digests(files, file.absolutePath, fileSize, full = false)
        assertEquals(fileSha, d.sha256)
        assertNull(quick.sha256)
        assertEquals(d.headSha256, quick.headSha256)
        assertEquals(d.tailSha256, quick.tailSha256)
        val bytes = file.readBytes()
        assertEquals(Hashing.hex(MessageDigest.getInstance("SHA-256").digest(bytes.copyOfRange(0, fileSize.toInt()))), d.headSha256) // file < 1 MiB: head is the whole file
    }
}
