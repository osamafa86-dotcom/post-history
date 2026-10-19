package net.palpost.library.core.upload

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger

/**
 * One MockWebServer that plays both the API (`/v1/uploads`) and tusd (`/files/`) with tus 1.0 semantics,
 * plus planned faults: drop the connection after storing only part of a PATCH body, or lose a request.
 */
class FakeTusd(private val baseUrl: () -> String, private val now: () -> Long) : Dispatcher() {
    val uploads = LinkedHashMap<String, ByteArrayOutputStream>()
    val declaredSizes = HashMap<String, Long>()
    val log = ArrayList<String>()
    var token = "upload-token-1"
    var sessionId = "5d6c7b8a-9f0e-4d1c-8b2a-3c4d5e6f7a8b"
    var partSize = 64 * 1024L
    var tokenTtlMs = 3_600_000L
    /** Server-side session state as the API reports it; tests move it to verified. */
    var sessionState = "in_progress"
    var failureReason: String? = null
    var receipt: String? = null
    /** PATCH number (1-based) at which the server keeps only the first half of the body and drops the socket. */
    val cutAtPatch = HashSet<Int>()
    /** PATCH numbers answered with a 5xx before anything is stored. */
    val serverErrorAtPatch = HashSet<Int>()
    /** Create numbers (1-based) whose 201 never reaches the client although the upload was created. */
    val loseCreateResponseAt = HashSet<Int>()
    /** The pre-create hook rejects every creation (session not reserved / wrong state) and no upload exists. */
    var rejectCreate = false
    val patches = AtomicInteger()
    val creates = AtomicInteger()
    val heads = AtomicInteger()
    val sessionCreates = AtomicInteger()
    val sessionCreateIdempotencyKeys = ArrayList<String>()
    val authorizations = ArrayList<String?>()

    /** Answer `Expect: 100-continue` at once, as tusd (Go's net/http) does; the JVM client otherwise waits 5 s per request. */
    override fun peek(): MockResponse = MockResponse().setSocketPolicy(SocketPolicy.CONTINUE_ALWAYS)

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.path ?: ""
        val method = if (request.getHeader("X-HTTP-Method-Override") == "PATCH") "PATCH" else request.method
        log.add("$method $path")
        return when {
            path == "/v1/uploads" && method == "POST" -> {
                sessionCreates.incrementAndGet()
                sessionCreateIdempotencyKeys.add(request.getHeader("Idempotency-Key") ?: "")
                json(201, sessionJson(withToken = true))
            }
            path == "/v1/uploads/$sessionId" && method == "GET" -> json(200, sessionJson(withToken = false))
            path == "/files/" && method == "POST" -> {
                authorizations.add(request.getHeader("Authorization"))
                if (request.getHeader("Authorization") != "Bearer $token") return json(401, "{}")
                val n = creates.incrementAndGet()
                if (rejectCreate) return MockResponse().setResponseCode(403)
                // Like the real pre-create hook: one creation per session/token, id = session id, 403 afterwards.
                if (uploads.containsKey(sessionId)) return MockResponse().setResponseCode(403)
                uploads[sessionId] = ByteArrayOutputStream()
                declaredSizes[sessionId] = request.getHeader("Upload-Length")!!.toLong()
                if (n in loseCreateResponseAt) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                MockResponse().setResponseCode(201).setHeader("Location", "/files/$sessionId").setHeader("Tus-Resumable", "1.0.0")
            }
            path.startsWith("/files/") -> {
                authorizations.add(request.getHeader("Authorization"))
                if (request.getHeader("Authorization") != "Bearer $token") return json(401, "{}")
                val id = path.removePrefix("/files/")
                val store = uploads[id] ?: return MockResponse().setResponseCode(404)
                when (method) {
                    "HEAD" -> { heads.incrementAndGet(); MockResponse().setResponseCode(200).setHeader("Upload-Offset", store.size().toString()).setHeader("Upload-Length", declaredSizes[id].toString()).setHeader("Tus-Resumable", "1.0.0") }
                    "PATCH" -> {
                        val n = patches.incrementAndGet()
                        if (n in serverErrorAtPatch) return MockResponse().setResponseCode(503)
                        val offset = request.getHeader("Upload-Offset")!!.toLong()
                        if (offset != store.size().toLong()) return MockResponse().setResponseCode(409)
                        val body = request.body.readByteArray()
                        if (n in cutAtPatch) {
                            store.write(body, 0, body.size / 2)
                            return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        }
                        store.write(body)
                        MockResponse().setResponseCode(204).setHeader("Upload-Offset", store.size().toString()).setHeader("Tus-Resumable", "1.0.0")
                    }
                    else -> MockResponse().setResponseCode(405)
                }
            }
            else -> MockResponse().setResponseCode(404)
        }
    }

    private fun iso(ms: Long) = OffsetDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneOffset.UTC).toString()

    private fun sessionJson(withToken: Boolean): String {
        val received = uploads.values.firstOrNull()?.size() ?: 0
        val tokenPart = if (withToken) ""","upload_token":"$token","upload_token_expires_at":"${iso(now() + tokenTtlMs)}"""" else ""
        return """{"id":"$sessionId","material_id":"7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b","kind":"original","state":"$sessionState",
            "size_bytes":${declaredSizes.values.firstOrNull() ?: 0},"tus_endpoint":"${baseUrl()}/files/","tus_metadata":{"upload_session_id":"$sessionId"},
            "part_size_bytes":$partSize,"bytes_received":$received,"expires_at":"${iso(now() + tokenTtlMs)}","created_at":"${iso(now())}",
            "receipt_number":${receipt?.let { "\"$it\"" } ?: "null"},"failure_reason":${failureReason?.let { "\"$it\"" } ?: "null"}$tokenPart}"""
    }

    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
}
