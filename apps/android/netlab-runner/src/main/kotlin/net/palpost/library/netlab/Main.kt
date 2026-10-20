package net.palpost.library.netlab

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import net.palpost.library.api.apis.UploadsApi
import net.palpost.library.core.upload.FileSource
import net.palpost.library.core.upload.InMemoryUploadStore
import net.palpost.library.core.upload.RunOutcome
import net.palpost.library.core.upload.TusTransport
import net.palpost.library.core.upload.UploadEngine
import net.palpost.library.core.upload.UploadTask
import java.io.File
import java.io.FileInputStream
import java.net.InetSocketAddress
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

/**
 * Runs one UploadTask through the real UploadEngine + TusTransport against a tus endpoint (the netlab
 * toxiproxy port) and prints one JSON object per line on stdout:
 *   {"t":<seconds since start>,"ev":"start"|"hashed"|"created"|"head"|"req"|"part"|"fail"|"end",...}
 * and, as the last line, the session summary in the terms of tools/netlab/netlab.py (its external-client
 * contract, `--client-cmd`): url_path, offset, complete, parts [[seconds, bytes, ok]] with the duration of
 * each PATCH request (a cut request counts as a failed part), windows (connected stretches from the first
 * successful request to the next failure), resumes (HEAD after a failure), failures, bytes_lost (a HEAD
 * below what the server had confirmed). netlab computes efficiency, checksum and the verdict from it;
 * apps/android/netlab/measure.py reads the same line until netlab.py carries the contract.
 * `POST /uploads` and `GET /uploads/{id}` are answered by an embedded stub (netlab has no API server):
 * the session carries the given tus endpoint, part size and a token the netlab hook stub accepts.
 *
 * Arguments: --file <path> --tus <url ending in /files/> [--part-bytes N] [--max-seconds S] [--timeout S]
 *            [--token T]
 */
fun main(args: Array<String>) {
    val a = args.toList().chunked(2).associate { it[0] to it.getOrElse(1) { "" } }
    val file = File(a.getValue("--file"))
    val tusEndpoint = a.getValue("--tus")
    val partBytes = a["--part-bytes"]?.toLong() ?: (1L shl 20)
    val maxSeconds = a["--max-seconds"]?.toLong() ?: 7200
    val readTimeoutMs = (a["--timeout"]?.toLong() ?: 90L) * 1000
    val token = a["--token"] ?: "netlab-upload-token"
    val sessionId = UUID.randomUUID().toString()

    val stub = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val iso = { OffsetDateTime.ofInstant(Instant.now().plusSeconds(86_400), ZoneOffset.UTC).toString() }
    fun sessionJson(withToken: Boolean, state: String) = """{"id":"$sessionId","material_id":"${UUID.randomUUID()}","kind":"original","state":"$state",
        "size_bytes":${file.length()},"tus_endpoint":"$tusEndpoint","tus_metadata":{"upload_session_id":"$sessionId"},
        "part_size_bytes":$partBytes,"bytes_received":0,"expires_at":"${iso()}","created_at":"${iso()}",
        "receipt_number":${if (state == "verified") "\"R-000000-000000\"" else "null"}${if (withToken) ""","upload_token":"$token","upload_token_expires_at":"${iso()}"""" else ""}}"""
    stub.createContext("/v1/uploads") { ex ->
        val body = when {
            ex.requestMethod == "POST" -> sessionJson(withToken = true, state = "created")
            else -> sessionJson(withToken = false, state = "verified") // asked only once every byte is on tusd
        }.toByteArray()
        ex.responseHeaders.add("Content-Type", "application/json")
        ex.sendResponseHeaders(if (ex.requestMethod == "POST") 201 else 200, body.size.toLong())
        ex.responseBody.use { it.write(body) }
    }
    stub.start()

    val t0 = System.nanoTime()
    fun now() = (System.nanoTime() - t0) / 1e9
    fun t() = "%.3f".format(now())
    val out = System.out
    fun emit(ev: String, fields: String = "") = synchronized(out) { out.println("""{"t":${t()},"ev":"$ev"$fields}"""); out.flush() }

    val summary = Summary()
    val observer = object : TusTransport.Observer {
        override fun onCreated(uploadUrl: String) { summary.created(uploadUrl, now()); emit("created", ""","url":"$uploadUrl"""") }
        override fun onHead(offset: Long) { summary.head(offset, now()); emit("head", ""","offset":$offset""") }
        override fun onRequestStart(offset: Long, payloadBytes: Int) { summary.requestStart(offset, now()); emit("req", ""","offset":$offset,"bytes":$payloadBytes""") }
        override fun onRequestDone(fromOffset: Long, toOffset: Long) { summary.requestDone(fromOffset, toOffset, now()); emit("part", ""","from":$fromOffset,"to":$toOffset""") }
        override fun onFailure(stage: String, error: Throwable) { summary.failure(now()); emit("fail", ""","stage":"$stage","kind":"${error::class.java.simpleName}"""") }
    }
    val store = InMemoryUploadStore()
    val engine = UploadEngine(
        store = store,
        files = FileSource { FileInputStream(File(it)) },
        uploadsApi = UploadsApi("http://127.0.0.1:${stub.address.port}/v1"),
        transport = TusTransport(readTimeoutMs = readTimeoutMs.toInt(), observer = observer),
    )
    val task = UploadTask(
        id = "netlab", materialId = UUID.randomUUID().toString(), kind = "original", fileUri = file.absolutePath,
        filename = file.name, mimeType = "application/octet-stream", sizeBytes = file.length(),
        idempotencyKey = UUID.randomUUID().toString(), createdAtEpochMs = System.currentTimeMillis(),
    )
    val deadlineNs = t0 + maxSeconds * 1_000_000_000L
    emit("start", ""","size":${file.length()},"part_bytes":$partBytes""")
    val outcome = runBlocking {
        store.save(task)
        var hashedEmitted = false
        engine.run("netlab", shouldStop = {
            val s = store.let { runBlocking { it.get("netlab") } }
            if (!hashedEmitted && s != null && s.sha256 != null) { hashedEmitted = true; emit("hashed", ""","sha256":"${s.sha256}"""") }
            System.nanoTime() > deadlineNs
        }) { _, _ -> }
    }
    val final = runBlocking { store.get("netlab") }!!
    emit("end", ""","outcome":"${outcome::class.java.simpleName}","state":"${final.state}","confirmed":${final.bytesConfirmed},"url":${final.tusUploadUrl?.let { "\"$it\"" } ?: "null"},"sha256":${final.sha256?.let { "\"$it\"" } ?: "null"},"failure":${final.failure?.let { "\"$it\"" } ?: "null"}""")
    val complete = outcome is RunOutcome.Finished && final.state.name == "VERIFIED"
    emit("summary", summary.json(now(), complete, final.sha256))
    stub.stop(0)
    System.exit(if (complete) 0 else 2)
}

/** The session in netlab's terms (see the file comment); every number comes from the transport's events. */
class Summary {
    private val parts = ArrayList<Triple<Double, Long, Boolean>>()
    private val windows = ArrayList<Double>()
    private var connectedSince: Double? = null
    private var requestStartedAt: Double? = null
    private var requestStartOffset = 0L
    private var failedSinceHead = false
    private var confirmed = 0L
    var resumes = 0; var failures = 0; var bytesLost = 0L; var urlPath: String? = null

    private fun ok(t: Double) { if (connectedSince == null) connectedSince = t }

    fun created(url: String, t: Double) { urlPath = runCatching { java.net.URI(url).rawPath }.getOrNull() ?: url; ok(t) }
    fun head(offset: Long, t: Double) {
        if (failedSinceHead) { resumes++; failedSinceHead = false }
        bytesLost += maxOf(0L, confirmed - offset)
        confirmed = maxOf(confirmed, offset)
        ok(t)
    }
    fun requestStart(offset: Long, t: Double) { requestStartedAt = t; requestStartOffset = offset }
    fun requestDone(from: Long, to: Long, t: Double) {
        parts.add(Triple(t - (requestStartedAt ?: t), to - from, true))
        requestStartedAt = null
        confirmed = maxOf(confirmed, to)
        ok(t)
    }
    fun failure(t: Double) {
        failures++
        failedSinceHead = true
        requestStartedAt?.let { parts.add(Triple(t - it, 0L, false)); requestStartedAt = null }
        connectedSince?.let { windows.add(t - it); connectedSince = null }
    }
    fun json(t: Double, complete: Boolean, sha256: String?): String {
        connectedSince?.let { windows.add(t - it) }
        val p = parts.joinToString(",") { (s, b, k) -> "[%.3f,%d,%s]".format(s, b, k) }
        val w = windows.joinToString(",") { "%.3f".format(it) }
        return ""","url_path":${urlPath?.let { "\"$it\"" } ?: "null"},"offset":$confirmed,"complete":$complete,"parts":[$p],"windows":[$w],"resumes":$resumes,"failures":$failures,"bytes_lost":$bytesLost,"device_sha256":${sha256?.let { "\"$it\"" } ?: "null"}"""
    }
}
