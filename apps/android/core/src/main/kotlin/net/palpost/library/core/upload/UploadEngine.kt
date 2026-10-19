package net.palpost.library.core.upload

import io.tus.java.client.ProtocolException
import kotlinx.coroutines.delay
import net.palpost.library.api.apis.UploadsApi
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.api.infrastructure.ServerException
import net.palpost.library.api.models.ClientFingerprint
import net.palpost.library.api.models.UploadSession
import net.palpost.library.api.models.UploadSessionCreate
import net.palpost.library.core.net.ApiFailure
import java.io.FileNotFoundException
import java.io.IOException
import java.util.UUID

/** What a run of the engine ended with. */
sealed interface RunOutcome {
    /** The task reached a terminal state (verified, deduplicated or failed). */
    data object Finished : RunOutcome
    /** Stopped on request; progress is persisted and a later run resumes. */
    data object Stopped : RunOutcome
    /** Could not progress now (offline, server down, receipt not issued yet); call again later. */
    data class Pending(val retryAfterMs: Long) : RunOutcome
}

/**
 * Drives one [UploadTask] through its states, persisting after every step the server acknowledged, so
 * that a kill at any point resumes from the last confirmed byte: hashing → `POST /uploads` (idempotent)
 * → tus create → tus resume/patch → poll `GET /uploads/{id}` for the receipt number.
 *
 * Transient trouble (I/O, 5xx, 409 offset races) is retried with backoff for as long as the host lets the
 * run live; auth is handled by the HTTP client; everything else is a terminal [UploadFailure].
 */
class UploadEngine(
    private val store: UploadStore,
    private val files: FileSource,
    private val uploadsApi: UploadsApi,
    private val transport: TusTransport = TusTransport(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val config: Config = Config(),
    /** Battery permitting: the full SHA-256 costs one read of the file before any byte is sent. */
    private val allowFullHash: () -> Boolean = { true },
) {
    data class Config(
        val maxRequestPayloadBytes: Int = 16 * 1024 * 1024,
        val minRequestPayloadBytes: Int = 1024 * 1024,
        val chunkBytes: Int = TusTransport.DEFAULT_CHUNK_BYTES,
        val backoffMs: List<Long> = listOf(2_000, 5_000, 15_000, 30_000, 60_000),
        /** How long one run keeps polling for the receipt before handing back [RunOutcome.Pending]. */
        val receiptPollBudgetMs: Long = 10 * 60_000,
        val receiptPollMs: List<Long> = listOf(3_000, 5_000, 10_000, 20_000, 30_000),
        val transientLimit: Int = Int.MAX_VALUE,
    )

    /** Progress for display: bytes written so far (ahead of what is confirmed and persisted). */
    fun interface ProgressListener { fun onProgress(task: UploadTask, bytesSent: Long) }

    suspend fun run(taskId: String, shouldStop: () -> Boolean = { false }, listener: ProgressListener? = null): RunOutcome {
        var transientFailures = 0
        while (true) {
            val task = store.get(taskId) ?: return RunOutcome.Finished
            if (task.state.terminal) return RunOutcome.Finished
            if (shouldStop()) return RunOutcome.Stopped
            try {
                when (task.state) {
                    UploadState.QUEUED, UploadState.HASHING -> hash(task, shouldStop)
                    UploadState.CREATING_SESSION -> createSession(task)
                    UploadState.UPLOADING -> {
                        val outcome = transfer(task, shouldStop, listener)
                        if (outcome != null) return outcome
                    }
                    UploadState.AWAITING_RECEIPT -> awaitReceipt(task, shouldStop)?.let { return it }
                    else -> return RunOutcome.Finished
                }
                transientFailures = 0
            } catch (e: Transient) {
                transientFailures++
                if (transientFailures > config.transientLimit) return RunOutcome.Pending(config.backoffMs.last())
                val wait = config.backoffMs[minOf(transientFailures - 1, config.backoffMs.lastIndex)]
                if (shouldStop()) return RunOutcome.Stopped
                sleep(wait)
            }
        }
    }

    private suspend fun persist(task: UploadTask) = store.save(task.copy(updatedAtEpochMs = clock()))

    private suspend fun fail(task: UploadTask, failure: UploadFailure, code: String? = null) =
        persist(task.copy(state = UploadState.FAILED, failure = failure, failureCode = code))

    private suspend fun hash(task: UploadTask, shouldStop: () -> Boolean) {
        persist(task.copy(state = UploadState.HASHING))
        val digests = try {
            Hashing.digests(files, task.fileUri, task.sizeBytes, full = allowFullHash(), isCancelled = shouldStop)
        } catch (e: Hashing.InterruptedHashException) {
            return // the run loop sees shouldStop() and returns Stopped; state stays HASHING
        } catch (e: FileNotFoundException) {
            fail(task, UploadFailure.FILE_UNAVAILABLE); return
        } catch (e: SecurityException) {
            fail(task, UploadFailure.FILE_UNAVAILABLE); return
        }
        persist(task.copy(state = UploadState.CREATING_SESSION, sha256 = digests.sha256, headSha256 = digests.headSha256, tailSha256 = digests.tailSha256))
    }

    private suspend fun createSession(task: UploadTask) {
        val session = try {
            uploadsApi.createUploadSession(
                task.idempotencyKey,
                UploadSessionCreate(
                    materialId = UUID.fromString(task.materialId),
                    kind = UploadSessionCreate.Kind.entries.firstOrNull { it.value == task.kind } ?: UploadSessionCreate.Kind.original,
                    sizeBytes = task.sizeBytes,
                    filename = task.filename,
                    mimeType = task.mimeType,
                    clientSha256 = task.sha256,
                    clientFingerprint = if (task.headSha256 != null && task.tailSha256 != null) ClientFingerprint(task.sizeBytes, task.headSha256, task.tailSha256) else null,
                ),
            )
        } catch (e: ClientException) {
            if (e.statusCode == 401 || e.statusCode == 429) throw Transient(e)
            fail(task, UploadFailure.REJECTED, ApiFailure.from(e)?.code ?: e.statusCode.toString()); return
        } catch (e: ServerException) {
            throw Transient(e)
        } catch (e: IOException) {
            throw Transient(e)
        }
        persist(
            task.copy(
                state = UploadState.UPLOADING,
                sessionId = session.id.toString(),
                tusEndpoint = session.tusEndpoint.toString(),
                uploadToken = session.uploadToken,
                tokenExpiresAtEpochMs = session.uploadTokenExpiresAt.toInstant().toEpochMilli(),
                sessionExpiresAtEpochMs = session.expiresAt.toInstant().toEpochMilli(),
                partSizeBytes = session.partSizeBytes,
                attempts = 0,
            ),
        )
    }

    /** Returns an outcome when the run must end here; null when the loop should continue with the next state. */
    private suspend fun transfer(task: UploadTask, shouldStop: () -> Boolean, listener: ProgressListener?): RunOutcome? {
        val token = task.uploadToken ?: run { fail(task, UploadFailure.UNKNOWN); return null }
        val expiresAt = task.tokenExpiresAtEpochMs ?: Long.MAX_VALUE
        if (clock() >= expiresAt) { fail(task, UploadFailure.SESSION_EXPIRED); return null }

        var current = task
        if (current.tusUploadUrl == null) {
            val url = try {
                transport.create(current.tusEndpoint!!, token, current.sizeBytes, mapOf("upload_session_id" to current.sessionId!!, "filename" to current.filename))
            } catch (e: ProtocolException) {
                return classify(current, e)
            } catch (e: IOException) {
                throw Transient(e)
            }
            current = current.copy(tusUploadUrl = url)
            persist(current)
        }

        val payload = (current.partSizeBytes ?: config.maxRequestPayloadBytes.toLong()).coerceIn(config.minRequestPayloadBytes.toLong(), config.maxRequestPayloadBytes.toLong()).toInt()
        val latest = current
        val confirmed = try {
            transport.upload(
                uploadUrl = latest.tusUploadUrl!!,
                token = token,
                sizeBytes = latest.sizeBytes,
                openStream = { files.open(latest.fileUri) },
                requestPayloadBytes = payload,
                chunkBytes = config.chunkBytes,
                shouldStop = shouldStop,
                onConfirmed = { offset -> if (offset != latest.bytesConfirmed) blockingPersist(latest.copy(bytesConfirmed = offset, attempts = 0)) },
                onSent = { sent -> listener?.onProgress(latest, sent) },
            )
        } catch (e: ProtocolException) {
            return classify(current, e)
        } catch (e: FileNotFoundException) {
            fail(current, UploadFailure.FILE_UNAVAILABLE); return null
        } catch (e: IOException) {
            persist(current.copy(attempts = current.attempts + 1))
            throw Transient(e)
        }
        val fresh = store.get(current.id) ?: return RunOutcome.Finished
        if (confirmed >= current.sizeBytes) {
            persist(fresh.copy(state = UploadState.AWAITING_RECEIPT, bytesConfirmed = current.sizeBytes))
            return null
        }
        return if (shouldStop()) RunOutcome.Stopped else throw Transient(IOException("upload ended early at $confirmed"))
    }

    /** A persisted write from a non-suspending callback: the store is synchronous underneath on both platforms. */
    private fun blockingPersist(task: UploadTask) = kotlinx.coroutines.runBlocking { persist(task) }

    private suspend fun classify(task: UploadTask, e: ProtocolException): RunOutcome? {
        return when (val status = TusTransport.status(e)) {
            null -> throw Transient(e)
            401, 403 -> { fail(task, UploadFailure.SESSION_EXPIRED, status.toString()); null }
            404, 410 -> { fail(task, UploadFailure.SESSION_EXPIRED, status.toString()); null }
            409, 423 -> throw Transient(e) // offset race or lock held by a dying connection: HEAD again shortly
            in 500..599 -> throw Transient(e)
            else -> { fail(task, UploadFailure.REJECTED, status.toString()); null }
        }
    }

    private suspend fun awaitReceipt(task: UploadTask, shouldStop: () -> Boolean): RunOutcome? {
        val started = clock()
        var poll = 0
        while (true) {
            if (shouldStop()) return RunOutcome.Stopped
            val session = try {
                uploadsApi.getUploadSession(UUID.fromString(task.sessionId!!))
            } catch (e: ClientException) {
                if (e.statusCode == 404) { fail(task, UploadFailure.UNKNOWN, "not_found"); return null }
                throw Transient(e)
            } catch (e: ServerException) {
                throw Transient(e)
            } catch (e: IOException) {
                throw Transient(e)
            }
            when (session.state) {
                UploadSession.State.verified -> { persist(task.copy(state = UploadState.VERIFIED, receiptNumber = session.receiptNumber)); return null }
                UploadSession.State.deduplicated -> { persist(task.copy(state = UploadState.DEDUPLICATED, receiptNumber = session.receiptNumber)); return null }
                UploadSession.State.failed -> {
                    val failure = when (session.failureReason) {
                        UploadSession.FailureReason.checksum_mismatch -> UploadFailure.CHECKSUM_MISMATCH
                        UploadSession.FailureReason.invalid_file -> UploadFailure.INVALID_FILE
                        UploadSession.FailureReason.expired -> UploadFailure.SESSION_EXPIRED
                        UploadSession.FailureReason.aborted -> UploadFailure.ABORTED
                        UploadSession.FailureReason.storage_error -> UploadFailure.STORAGE_ERROR
                        null -> UploadFailure.UNKNOWN
                    }
                    fail(task, failure, session.failureReason?.value); return null
                }
                else -> {
                    if (clock() - started >= config.receiptPollBudgetMs) return RunOutcome.Pending(config.receiptPollMs.last())
                    sleep(config.receiptPollMs[minOf(poll, config.receiptPollMs.lastIndex)])
                    poll++
                }
            }
        }
    }

    private class Transient(cause: Throwable) : Exception(cause)
}
