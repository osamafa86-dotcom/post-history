package net.palpost.library.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow
import net.palpost.library.auth.KeystoreSealer
import net.palpost.library.core.upload.UploadFailure
import net.palpost.library.core.upload.UploadState
import net.palpost.library.core.upload.UploadStore
import net.palpost.library.core.upload.UploadTask

/** The queue row. `uploadToken` is sealed with the Keystore; everything else is plain app-private data. */
@Entity(tableName = "upload_tasks")
data class UploadTaskEntity(
    @PrimaryKey val id: String,
    val materialId: String,
    val kind: String,
    val fileUri: String,
    val filename: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val idempotencyKey: String,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
    val state: String,
    val sha256: String?,
    val headSha256: String?,
    val tailSha256: String?,
    val sessionId: String?,
    val tusEndpoint: String?,
    val tusUploadUrl: String?,
    val sealedUploadToken: String?,
    val tokenExpiresAtEpochMs: Long?,
    val sessionExpiresAtEpochMs: Long?,
    val partSizeBytes: Long?,
    @androidx.room.ColumnInfo(defaultValue = "0") val ingestTokenRequired: Boolean = false,
    val bytesConfirmed: Long,
    val receiptNumber: String?,
    val failure: String?,
    val failureCode: String?,
    val attempts: Int,
    /** Material title typed by the reporter, for the list only; never logged. */
    val title: String,
    /** The reporter already decided about the local copy (deleted it or chose to keep it). */
    val localCopyHandled: Boolean = false,
)

@Dao
interface UploadDao {
    @Query("SELECT * FROM upload_tasks WHERE id = :id") suspend fun get(id: String): UploadTaskEntity?
    @Upsert suspend fun upsert(entity: UploadTaskEntity)
    @Query("SELECT * FROM upload_tasks WHERE state NOT IN ('VERIFIED','DEDUPLICATED','FAILED') ORDER BY createdAtEpochMs") suspend fun pending(): List<UploadTaskEntity>
    @Query("SELECT COUNT(*) FROM upload_tasks WHERE state NOT IN ('VERIFIED','DEDUPLICATED','FAILED')") suspend fun pendingCount(): Int
    @Query("SELECT * FROM upload_tasks ORDER BY createdAtEpochMs DESC") fun observeAll(): Flow<List<UploadTaskEntity>>
    @Query("UPDATE upload_tasks SET localCopyHandled = :handled WHERE id = :id") suspend fun setLocalCopyHandled(id: String, handled: Boolean)
    @Query("UPDATE upload_tasks SET state = 'QUEUED', failure = NULL, failureCode = NULL, attempts = 0, sessionId = NULL, tusEndpoint = NULL, tusUploadUrl = NULL, sealedUploadToken = NULL, tokenExpiresAtEpochMs = NULL, sessionExpiresAtEpochMs = NULL, ingestTokenRequired = 0, bytesConfirmed = 0, idempotencyKey = :newIdempotencyKey WHERE id = :id AND state = 'FAILED'")
    suspend fun requeueFailed(id: String, newIdempotencyKey: String)
    @Query("DELETE FROM upload_tasks") suspend fun deleteAll()
}

@Database(entities = [UploadTaskEntity::class], version = 2, exportSchema = false)
abstract class UploadDatabase : RoomDatabase() {
    abstract fun uploads(): UploadDao

    companion object {
        fun open(context: Context): UploadDatabase =
            Room.databaseBuilder(context.applicationContext, UploadDatabase::class.java, "uploads.db").addMigrations(MIGRATION_1_2).build()

        /** v2: sessions behind the ingest gate (SEC-07). Existing rows predate the gate. */
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE upload_tasks ADD COLUMN ingestTokenRequired INTEGER NOT NULL DEFAULT 0")
            }
        }
    }
}

/** Core's queue interface over Room; writes are synchronous commits, as the engine requires. */
class RoomUploadStore(private val dao: UploadDao, private val sealer: KeystoreSealer) : UploadStore {
    override suspend fun get(id: String): UploadTask? = dao.get(id)?.let { toTask(it) }

    override suspend fun save(task: UploadTask) {
        val existing = dao.get(task.id)
        dao.upsert(toEntity(task, title = existing?.title ?: "", localCopyHandled = existing?.localCopyHandled ?: false))
    }

    override suspend fun pending(): List<UploadTask> = dao.pending().map { toTask(it) }

    suspend fun insert(task: UploadTask, title: String) = dao.upsert(toEntity(task, title, localCopyHandled = false))

    fun toTask(e: UploadTaskEntity) = UploadTask(
        id = e.id, materialId = e.materialId, kind = e.kind, fileUri = e.fileUri, filename = e.filename, mimeType = e.mimeType,
        sizeBytes = e.sizeBytes, idempotencyKey = e.idempotencyKey, createdAtEpochMs = e.createdAtEpochMs, updatedAtEpochMs = e.updatedAtEpochMs,
        state = UploadState.valueOf(e.state), sha256 = e.sha256, headSha256 = e.headSha256, tailSha256 = e.tailSha256,
        sessionId = e.sessionId, tusEndpoint = e.tusEndpoint, tusUploadUrl = e.tusUploadUrl,
        uploadToken = e.sealedUploadToken?.let { runCatching { sealer.openString(it) }.getOrNull() },
        tokenExpiresAtEpochMs = e.tokenExpiresAtEpochMs, sessionExpiresAtEpochMs = e.sessionExpiresAtEpochMs, partSizeBytes = e.partSizeBytes,
        ingestTokenRequired = e.ingestTokenRequired, bytesConfirmed = e.bytesConfirmed, receiptNumber = e.receiptNumber, failure = e.failure?.let { UploadFailure.valueOf(it) },
        failureCode = e.failureCode, attempts = e.attempts,
    )

    private fun toEntity(t: UploadTask, title: String, localCopyHandled: Boolean) = UploadTaskEntity(
        id = t.id, materialId = t.materialId, kind = t.kind, fileUri = t.fileUri, filename = t.filename, mimeType = t.mimeType,
        sizeBytes = t.sizeBytes, idempotencyKey = t.idempotencyKey, createdAtEpochMs = t.createdAtEpochMs, updatedAtEpochMs = t.updatedAtEpochMs,
        state = t.state.name, sha256 = t.sha256, headSha256 = t.headSha256, tailSha256 = t.tailSha256,
        sessionId = t.sessionId, tusEndpoint = t.tusEndpoint, tusUploadUrl = t.tusUploadUrl,
        sealedUploadToken = t.uploadToken?.let { sealer.sealString(it) },
        tokenExpiresAtEpochMs = t.tokenExpiresAtEpochMs, sessionExpiresAtEpochMs = t.sessionExpiresAtEpochMs, partSizeBytes = t.partSizeBytes,
        ingestTokenRequired = t.ingestTokenRequired, bytesConfirmed = t.bytesConfirmed, receiptNumber = t.receiptNumber, failure = t.failure?.name, failureCode = t.failureCode, attempts = t.attempts,
        title = title, localCopyHandled = localCopyHandled,
    )
}
