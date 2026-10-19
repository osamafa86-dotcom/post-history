package net.palpost.library.core.upload

import io.tus.java.client.ProtocolException
import io.tus.java.client.TusClient
import io.tus.java.client.TusUpload
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The tus 1.0 leg on top of the platform's ready client (tus-java-client), used the way the server expects:
 * one upload per session, `Authorization: Bearer <upload token>` on every request, `Upload-Metadata` as
 * `POST /uploads` returned it. Creation and resumption are separate on purpose: a lost upload URL is a
 * terminal failure here, never a silent second creation that the pre-create hook would reject anyway.
 */
open class TusTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 90_000,
) {
    /** `POST` to the creation endpoint; returns the upload URL. */
    @Throws(IOException::class, ProtocolException::class)
    open fun create(endpoint: String, token: String, sizeBytes: Long, metadata: Map<String, String>): String {
        val client = client(token).apply { uploadCreationURL = URL(endpoint) }
        val upload = TusUpload().apply { size = sizeBytes; this.metadata = metadata; inputStream = java.io.ByteArrayInputStream(ByteArray(0)) }
        val uploader = client.createUpload(upload)
        val url = uploader.uploadURL.toString()
        uploader.finish(true)
        return url
    }

    /** `HEAD` the upload; the offset the server has. */
    @Throws(IOException::class, ProtocolException::class)
    open fun offset(uploadUrl: String, token: String): Long {
        val upload = TusUpload().apply { size = 0; inputStream = java.io.ByteArrayInputStream(ByteArray(0)) }
        val uploader = client(token).beginOrResumeUploadFromURL(upload, URL(uploadUrl))
        val offset = uploader.offset
        uploader.finish(true)
        return offset
    }

    /**
     * Resumes from whatever `HEAD` reports and sends until the end, [shouldStop] or a failure. [onConfirmed]
     * fires with each offset the server acknowledged (request boundaries), [onSent] with bytes written so
     * far for display only. Returns the last confirmed offset.
     */
    @Throws(IOException::class, ProtocolException::class)
    open fun upload(
        uploadUrl: String,
        token: String,
        sizeBytes: Long,
        openStream: () -> java.io.InputStream,
        requestPayloadBytes: Int,
        chunkBytes: Int = DEFAULT_CHUNK_BYTES,
        shouldStop: () -> Boolean = { false },
        onConfirmed: (Long) -> Unit = {},
        onSent: (Long) -> Unit = {},
    ): Long {
        val stream = openStream()
        val upload = TusUpload().apply { size = sizeBytes; inputStream = stream }
        val uploader = try { client(token).beginOrResumeUploadFromURL(upload, URL(uploadUrl)) } catch (e: Throwable) { runCatching { stream.close() }; throw e }
        uploader.setChunkSize(chunkBytes)
        uploader.setRequestPayloadSize(requestPayloadBytes)
        var confirmed = uploader.offset
        var requestStart = confirmed
        try {
            while (!shouldStop()) {
                val n = uploader.uploadChunk()
                if (n < 0) break
                onSent(uploader.offset)
                if (uploader.offset - requestStart >= requestPayloadBytes) {
                    // tus-java-client closed and checked this request inside uploadChunk(): acknowledged.
                    confirmed = uploader.offset
                    requestStart = confirmed
                    onConfirmed(confirmed)
                }
            }
            // Ends the open request (if any) and verifies the server's final offset; a stop mid-request
            // still lands the bytes already written.
            uploader.finish(true)
            confirmed = uploader.offset
            onConfirmed(confirmed)
            return confirmed
        } catch (e: Throwable) {
            runCatching { stream.close() }
            throw e
        }
    }

    private fun client(token: String): TusClient = object : TusClient() {
        override fun prepareConnection(connection: HttpURLConnection) {
            super.prepareConnection(connection)
            connection.readTimeout = readTimeoutMs
        }
    }.apply {
        connectTimeout = connectTimeoutMs
        setHeaders(mapOf("Authorization" to "Bearer $token"))
    }

    companion object {
        const val DEFAULT_CHUNK_BYTES = 256 * 1024

        /** HTTP status behind a tus failure, or null when the connection died before any response. */
        fun status(e: ProtocolException): Int? = runCatching { e.causingConnection?.responseCode }.getOrNull()?.takeIf { it > 0 }
    }
}
