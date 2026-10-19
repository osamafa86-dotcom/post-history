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
 * toxiproxy port) and prints one JSON object per line on stdout for apps/android/netlab/measure.py:
 *   {"t":<seconds since start>,"ev":"hashed"|"created"|"head"|"part"|"fail"|"confirmed"|"end",...}
 * `POST /uploads` and `GET /uploads/{id}` are answered by an embedded stub (netlab has no API server):
 * the session carries the given tus endpoint, part size and a token the netlab hook stub accepts.
 *
 * Arguments: --file <path> --tus <url ending in /files/> [--part-bytes N] [--max-seconds S] [--token T]
 */
fun main(args: Array<String>) {
    val a = args.toList().chunked(2).associate { it[0] to it.getOrElse(1) { "" } }
    val file = File(a.getValue("--file"))
    val tusEndpoint = a.getValue("--tus")
    val partBytes = a["--part-bytes"]?.toLong() ?: (1L shl 20)
    val maxSeconds = a["--max-seconds"]?.toLong() ?: 7200
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
    fun t() = "%.3f".format((System.nanoTime() - t0) / 1e9)
    val out = System.out
    fun emit(ev: String, fields: String = "") = synchronized(out) { out.println("""{"t":${t()},"ev":"$ev"$fields}"""); out.flush() }

    val observer = object : TusTransport.Observer {
        override fun onCreated(uploadUrl: String) = emit("created", ""","url":"$uploadUrl"""")
        override fun onHead(offset: Long) = emit("head", ""","offset":$offset""")
        override fun onRequestDone(fromOffset: Long, toOffset: Long) = emit("part", ""","from":$fromOffset,"to":$toOffset""")
        override fun onFailure(stage: String, error: Throwable) = emit("fail", ""","stage":"$stage","kind":"${error::class.java.simpleName}"""")
    }
    val store = InMemoryUploadStore()
    val engine = UploadEngine(
        store = store,
        files = FileSource { FileInputStream(File(it)) },
        uploadsApi = UploadsApi("http://127.0.0.1:${stub.address.port}/v1"),
        transport = TusTransport(observer = observer),
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
    stub.stop(0)
    System.exit(if (outcome is RunOutcome.Finished && final.state.name == "VERIFIED") 0 else 2)
}
