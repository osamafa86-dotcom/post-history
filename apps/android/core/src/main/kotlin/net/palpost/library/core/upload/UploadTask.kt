package net.palpost.library.core.upload

/** Where a queued file is on its way from the phone to a verified receipt. */
enum class UploadState {
    /** Picked and persisted; nothing sent yet. */
    QUEUED,
    /** Hashing on the device (SHA-256 of the whole file plus the cheap head/tail fingerprint). */
    HASHING,
    /** `POST /uploads` not yet answered. */
    CREATING_SESSION,
    /** tus transfer in progress; `bytesConfirmed` is the last offset the server acknowledged. */
    UPLOADING,
    /** All bytes are on the server; waiting for assembly, verification and the receipt number. */
    AWAITING_RECEIPT,
    VERIFIED,
    DEDUPLICATED,
    FAILED;

    val terminal: Boolean get() = this == VERIFIED || this == DEDUPLICATED || this == FAILED
}

/** Why an upload stopped for good. Transient trouble (network, 5xx) never lands here. */
enum class UploadFailure {
    /** The upload token or session lapsed before the transfer finished; a new session is needed. */
    SESSION_EXPIRED,
    /** The server's SHA-256 differs from the file's. */
    CHECKSUM_MISMATCH,
    INVALID_FILE,
    /** The API refused the session (4xx other than auth), e.g. material not in scope or wrong state. */
    REJECTED,
    /** The picked file can no longer be opened on the device. */
    FILE_UNAVAILABLE,
    STORAGE_ERROR,
    ABORTED,
    /**
     * The upload gate needs a device attestation this install cannot give (Play Integrity refused the app or
     * device, or the app was not installed from Play): uploads go through the Play build only (SEC-07).
     */
    DEVICE_NOT_TRUSTED,
    UNKNOWN,
}

data class UploadTask(
    val id: String,
    val materialId: String,
    /** `original`, `proxy` or `voice_note` (contract enum). */
    val kind: String,
    val fileUri: String,
    val filename: String,
    val mimeType: String?,
    val sizeBytes: Long,
    /** Generated once when the task is queued; reused on every retry of `POST /uploads`. */
    val idempotencyKey: String,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long = createdAtEpochMs,
    val state: UploadState = UploadState.QUEUED,
    val sha256: String? = null,
    val headSha256: String? = null,
    val tailSha256: String? = null,
    val sessionId: String? = null,
    val tusEndpoint: String? = null,
    val tusUploadUrl: String? = null,
    val uploadToken: String? = null,
    val tokenExpiresAtEpochMs: Long? = null,
    val sessionExpiresAtEpochMs: Long? = null,
    val partSizeBytes: Long? = null,
    /** The session's tus endpoint is behind the ingest gate: every tus request carries `Ingest-Token` (SEC-07). */
    val ingestTokenRequired: Boolean = false,
    val bytesConfirmed: Long = 0,
    val receiptNumber: String? = null,
    val failure: UploadFailure? = null,
    /** Stable error code from the API when [failure] is REJECTED, for support; never shown raw. */
    val failureCode: String? = null,
    val attempts: Int = 0,
) {
    val progress: Float get() = if (sizeBytes <= 0) 0f else (bytesConfirmed.toDouble() / sizeBytes).coerceIn(0.0, 1.0).toFloat()
}

/** Persistence for the queue. Room on Android; memory in tests. Every write must be durable before it returns. */
interface UploadStore {
    suspend fun get(id: String): UploadTask?
    suspend fun save(task: UploadTask)
    /** Tasks that still need work, oldest first. */
    suspend fun pending(): List<UploadTask>
}

class InMemoryUploadStore : UploadStore {
    private val tasks = LinkedHashMap<String, UploadTask>()
    override suspend fun get(id: String): UploadTask? = synchronized(tasks) { tasks[id] }
    override suspend fun save(task: UploadTask) { synchronized(tasks) { tasks[task.id] = task } }
    override suspend fun pending(): List<UploadTask> = synchronized(tasks) { tasks.values.filterNot { it.state.terminal }.sortedBy { it.createdAtEpochMs } }
}

/** Opens the picked file as a stream; a content URI on Android, a path in tests. */
fun interface FileSource {
    @Throws(java.io.IOException::class)
    fun open(uri: String): java.io.InputStream
}
