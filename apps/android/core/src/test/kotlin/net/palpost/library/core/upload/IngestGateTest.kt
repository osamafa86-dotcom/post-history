package net.palpost.library.core.upload

import kotlinx.coroutines.runBlocking
import net.palpost.library.api.apis.UploadsApi
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/** Uploads through the ingest gate (SEC-07, ADR 0011): Play Integrity over `challenge ‖ session id`, then `Ingest-Token`. */
class IngestGateTest {
    private val server = MockWebServer()
    private lateinit var fake: FakeTusd
    private var now = 1_700_000_000_000L
    private val store = InMemoryUploadStore()
    private lateinit var file: File
    private val files = FileSource { uri -> FileInputStream(File(uri)) }
    private val fileSize = 300 * 1024L + 17
    private val config = UploadEngine.Config(maxRequestPayloadBytes = 64 * 1024, minRequestPayloadBytes = 16 * 1024, chunkBytes = 8 * 1024, receiptPollBudgetMs = 60_000)
    private val hashes = ArrayList<String>()

    @Before fun start() {
        server.start()
        fake = FakeTusd({ server.url("").toString().trimEnd('/') }, { now }).apply { gate = true; sessionState = "verified"; receipt = "R-202610-000100" }
        server.dispatcher = fake
        file = File.createTempFile("synthetic", ".bin").apply { deleteOnExit(); writeBytes(ByteArray(fileSize.toInt()).also { java.util.Random(7).nextBytes(it) }) }
    }

    @After fun stop() = server.shutdown()

    private fun api() = UploadsApi(server.url("/v1").toString().trimEnd('/'))

    private fun engine(attester: DeviceAttester?) = UploadEngine(
        store = store, files = files, uploadsApi = api(), transport = TusTransport(), clock = { now }, sleep = { ms -> now += ms },
        config = config, ingestTokens = attester?.let { IngestTokens(api(), it, clock = { now }) },
    )

    private val playIntegrity = DeviceAttester { hash -> hashes.add(hash); "integrity:$hash" }

    private suspend fun queue() = store.save(UploadTask(id = "t1", materialId = "7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b", kind = "original", fileUri = file.absolutePath, filename = "clip.mov", mimeType = "video/quicktime", sizeBytes = fileSize, idempotencyKey = "idem-1", createdAtEpochMs = now))

    @Test fun `a gated session uploads with a token bound to the session and the server's request hash`() = runBlocking {
        queue()
        assertEquals(RunOutcome.Finished, engine(playIntegrity).run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.VERIFIED, t.state)
        assertTrue(t.ingestTokenRequired)
        assertEquals(0, fake.gateRejections)
        assertEquals(1, fake.gateTokensIssued.get())
        // requestHash = base64url(SHA-256(challenge bytes ‖ session id)), computed here independently of IngestTokens.
        val challenge = java.util.Base64.getUrlDecoder().decode(fake.challengesIssued.single().second)
        val expected = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(challenge + fake.sessionId.toByteArray()))
        assertEquals(listOf(expected), hashes)
        assertEquals(fileSize, fake.uploads.values.single().size().toLong())
    }

    @Test fun `a token that lapses mid-upload is replaced and the upload resumes from the server offset`() = runBlocking {
        queue()
        fake.expireGateTokenAfterPatches = 2
        assertEquals(RunOutcome.Finished, engine(playIntegrity).run("t1"))
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)
        assertTrue("a fresh token after each 401", fake.gateTokensIssued.get() >= 3)
        assertEquals(fake.gateTokensIssued.get() - 1, fake.gateRejections)
        assertEquals(fileSize, fake.uploads.values.single().size().toLong())
    }

    @Test fun `a device Play does not recognise ends the task without sending a byte`() = runBlocking {
        queue()
        val refused = DeviceAttester { throw AttestationException(transient = false, "PLAY_STORE_NOT_FOUND") }
        assertEquals(RunOutcome.Finished, engine(refused).run("t1"))
        val t = store.get("t1")!!
        assertEquals(UploadState.FAILED, t.state)
        assertEquals(UploadFailure.DEVICE_NOT_TRUSTED, t.failure)
        assertEquals(0, fake.creates.get())
    }

    @Test fun `the server refusing the verdict (403) is terminal, a transient attestation error is retried`() = runBlocking {
        queue()
        var calls = 0
        val flaky = DeviceAttester { hash -> if (calls++ == 0) throw AttestationException(transient = true, "NETWORK_ERROR") else "integrity:$hash" }
        assertEquals(RunOutcome.Finished, engine(flaky).run("t1"))
        assertEquals(UploadState.VERIFIED, store.get("t1")!!.state)

        store.save(store.get("t1")!!.copy(id = "t2", state = UploadState.QUEUED, sessionId = null, tusUploadUrl = null, bytesConfirmed = 0))
        fake.uploads.clear(); fake.ingestTokenStatus = 403
        assertEquals(RunOutcome.Finished, engine(playIntegrity).run("t2"))
        assertEquals(UploadFailure.DEVICE_NOT_TRUSTED, store.get("t2")!!.failure)
    }

    @Test fun `a gated session without an attester fails as not trusted`() = runBlocking {
        queue()
        assertEquals(RunOutcome.Finished, engine(null).run("t1"))
        assertEquals(UploadFailure.DEVICE_NOT_TRUSTED, store.get("t1")!!.failure)
        assertEquals(0, fake.creates.get())
    }
}
