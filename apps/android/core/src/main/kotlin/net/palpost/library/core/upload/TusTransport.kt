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
    /** Protocol-level events for measurement tools (netlab); no-op in the app. */
    private val observer: Observer = Observer.NONE,
) {
    /**
     * What the transport does on the wire, with monotonic timing left to the observer. The app passes none:
     * nothing here may end up in a log, a notification or a screen (SEC-01: no records on the device).
     */
    interface Observer {
        /**
         * The upload was created at [uploadUrl]. The URL is a bearer capability on its own (tusd checks the
         * token at creation only, SEC-06): an observer in the app must neither log nor display it; a
         * measurement tool on a throwaway stack may.
         */
        fun onCreated(uploadUrl: String) {}
        /** `HEAD` answered: the offset the server holds before sending resumes. */
        fun onHead(offset: Long) {}
        /** A PATCH request is about to open at [offset] for [payloadBytes] bytes (fewer when the file ends). */
        fun onRequestStart(offset: Long, payloadBytes: Int) {}
        /** One PATCH request acknowledged, carrying bytes `[fromOffset, toOffset)`. */
        fun onRequestDone(fromOffset: Long, toOffset: Long) {}
        /** The transport is about to throw; the engine decides whether it is transient. */
        fun onFailure(stage: String, error: Throwable) {}

        companion object { val NONE: Observer = object : Observer {} }
    }

    /** `POST` to the creation endpoint; returns the upload URL. */
    @Throws(IOException::class, ProtocolException::class)
    open fun create(endpoint: String, token: String, sizeBytes: Long, metadata: Map<String, String>, headers: () -> Map<String, String> = NO_HEADERS): String {
        val client = client(token, headers).apply { uploadCreationURL = URL(endpoint) }
        val upload = TusUpload().apply { size = sizeBytes; this.metadata = metadata; inputStream = java.io.ByteArrayInputStream(ByteArray(0)) }
        val uploader = try { client.createUpload(upload) } catch (e: Exception) { observer.onFailure("create", e); throw e }
        val url = uploader.uploadURL.toString()
        uploader.finish(true)
        observer.onCreated(url)
        return url
    }

    /** `HEAD` the upload; the offset the server has. */
    @Throws(IOException::class, ProtocolException::class)
    open fun offset(uploadUrl: String, token: String, headers: () -> Map<String, String> = NO_HEADERS): Long {
        val upload = TusUpload().apply { size = 0; inputStream = java.io.ByteArrayInputStream(ByteArray(0)) }
        val uploader = try { client(token, headers).beginOrResumeUploadFromURL(upload, URL(uploadUrl)) } catch (e: Exception) { observer.onFailure("head", e); throw e }
        val offset = uploader.offset
        uploader.finish(true)
        observer.onHead(offset)
        return offset
    }

    /**
     * Resumes from whatever `HEAD` reports ([onHead]) and sends until the end, [shouldStop] or a failure.
     * [requestPayloadBytes] is asked before every PATCH with the offset it opens at, so the engine can size
     * requests to the link; [onConfirmed] fires with each offset the server acknowledged (request boundaries),
     * [onSent] with bytes written so far for display only. Returns the last confirmed offset.
     */
    @Throws(IOException::class, ProtocolException::class)
    open fun upload(
        uploadUrl: String,
        token: String,
        sizeBytes: Long,
        openStream: () -> java.io.InputStream,
        requestPayloadBytes: (offset: Long) -> Int,
        chunkBytes: Int = DEFAULT_CHUNK_BYTES,
        shouldStop: () -> Boolean = { false },
        onHead: (Long) -> Unit = {},
        onConfirmed: (Long) -> Unit = {},
        onSent: (Long) -> Unit = {},
        headers: () -> Map<String, String> = NO_HEADERS,
    ): Long {
        val stream = FullSkipInputStream(openStream())
        val upload = TusUpload().apply { size = sizeBytes; inputStream = stream }
        val uploader = try { client(token, headers).beginOrResumeUploadFromURL(upload, URL(uploadUrl)) } catch (e: Throwable) { runCatching { stream.close() }; if (e is Exception) observer.onFailure("head", e); throw e }
        uploader.setChunkSize(chunkBytes)
        var confirmed = uploader.offset
        var requestStart = confirmed
        observer.onHead(confirmed)
        onHead(confirmed)
        var payload = requestPayloadBytes(requestStart)
        uploader.setRequestPayloadSize(payload)
        if (confirmed < sizeBytes) observer.onRequestStart(requestStart, payload)
        try {
            while (!shouldStop()) {
                val n = uploader.uploadChunk()
                if (n < 0) break
                onSent(uploader.offset)
                if (uploader.offset - requestStart >= payload) {
                    // tus-java-client closed and checked this request inside uploadChunk(): acknowledged.
                    confirmed = uploader.offset
                    observer.onRequestDone(requestStart, confirmed)
                    requestStart = confirmed
                    onConfirmed(confirmed)
                    if (confirmed < sizeBytes) {
                        // No connection is open between requests: the next size may differ.
                        payload = requestPayloadBytes(requestStart)
                        uploader.setRequestPayloadSize(payload)
                        observer.onRequestStart(requestStart, payload)
                    }
                }
            }
            // Ends the open request (if any) and verifies the server's final offset; a stop mid-request
            // still lands the bytes already written.
            uploader.finish(true)
            if (uploader.offset > requestStart) observer.onRequestDone(requestStart, uploader.offset)
            confirmed = uploader.offset
            onConfirmed(confirmed)
            return confirmed
        } catch (e: Throwable) {
            runCatching { stream.close() }
            if (e is Exception) observer.onFailure("patch", e)
            throw e
        }
    }

    /** [headers] is asked on every connection, so a gate token renewed mid-upload reaches the next request. */
    private fun client(token: String, headers: () -> Map<String, String>): TusClient = object : TusClient() {
        override fun prepareConnection(connection: HttpURLConnection) {
            super.prepareConnection(connection)
            connection.readTimeout = readTimeoutMs
            headers().forEach { (k, v) -> connection.setRequestProperty(k, v) }
        }
    }.apply {
        connectTimeout = connectTimeoutMs
        setHeaders(mapOf("Authorization" to "Bearer $token"))
    }

    companion object {
        const val DEFAULT_CHUNK_BYTES = 256 * 1024
        val NO_HEADERS: () -> Map<String, String> = { emptyMap() }

        /** HTTP status behind a tus failure, or null when the connection died before any response. */
        fun status(e: ProtocolException): Int? = runCatching { e.causingConnection?.responseCode }.getOrNull()?.takeIf { it > 0 }
    }
}
