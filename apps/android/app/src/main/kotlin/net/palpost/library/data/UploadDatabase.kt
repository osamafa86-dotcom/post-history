package net.palpost.library.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
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
    /** The material's priority as the reporter set it (contract value), for the A2 badge; null before v3. */
    val priority: String? = null,
)

/**
 * A1 draft kept on the phone only (`Save draft`): the material's fields and the picked original's URI as JSON,
 * shown on A2 until sent. Cleared with every table by the emergency wipe (SEC-01).
 */
@Entity(tableName = "drafts")
data class DraftEntity(
    @PrimaryKey val id: String,
    val title: String,
    val json: String,
    val updatedAtEpochMs: Long,
)

@Dao
interface DraftDao {
    @Query("SELECT * FROM drafts ORDER BY updatedAtEpochMs DESC") fun observeAll(): Flow<List<DraftEntity>>
    @Query("SELECT * FROM drafts WHERE id = :id") suspend fun get(id: String): DraftEntity?
    @Upsert suspend fun upsert(entity: DraftEntity)
    @Query("DELETE FROM drafts WHERE id = :id") suspend fun delete(id: String)
    /** How many drafts mention this content URI (a LIKE over the JSON: wildcard characters in the URI only over-count, which keeps a grant). */
    @Query("SELECT COUNT(*) FROM drafts WHERE json LIKE '%' || :uri || '%'") suspend fun countMentioning(uri: String): Int
}

@Dao
interface UploadDao {
    @Query("SELECT * FROM upload_tasks WHERE id = :id") suspend fun get(id: String): UploadTaskEntity?
    @Query("SELECT * FROM upload_tasks WHERE id = :id") fun observe(id: String): Flow<UploadTaskEntity?>
    @Query("SELECT * FROM upload_tasks WHERE materialId = :materialId AND state IN ('VERIFIED','DEDUPLICATED') ORDER BY updatedAtEpochMs DESC LIMIT 1") suspend fun receiptFor(materialId: String): UploadTaskEntity?
    @Upsert suspend fun upsert(entity: UploadTaskEntity)
    /** Queues a row only if its id is new: a repeat of the same send never resets a row that has already progressed. Returns -1 when the row existed. */
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertIfAbsent(entity: UploadTaskEntity): Long
    /** Rows other than [exceptId] that still point at this content URI (the file is in use while one does). */
    @Query("SELECT COUNT(*) FROM upload_tasks WHERE fileUri = :uri AND id != :exceptId") suspend fun countByUri(uri: String, exceptId: String): Int
    @Query("SELECT * FROM upload_tasks WHERE state NOT IN ('VERIFIED','DEDUPLICATED','FAILED') ORDER BY createdAtEpochMs") suspend fun pending(): List<UploadTaskEntity>
    @Query("SELECT COUNT(*) FROM upload_tasks WHERE state NOT IN ('VERIFIED','DEDUPLICATED','FAILED')") suspend fun pendingCount(): Int
    @Query("SELECT * FROM upload_tasks ORDER BY createdAtEpochMs DESC") fun observeAll(): Flow<List<UploadTaskEntity>>
    @Query("UPDATE upload_tasks SET localCopyHandled = :handled WHERE id = :id") suspend fun setLocalCopyHandled(id: String, handled: Boolean)
    @Query("UPDATE upload_tasks SET state = 'QUEUED', failure = NULL, failureCode = NULL, attempts = 0, sessionId = NULL, tusEndpoint = NULL, tusUploadUrl = NULL, sealedUploadToken = NULL, tokenExpiresAtEpochMs = NULL, sessionExpiresAtEpochMs = NULL, ingestTokenRequired = 0, bytesConfirmed = 0, idempotencyKey = :newIdempotencyKey WHERE id = :id AND state = 'FAILED'")
    suspend fun requeueFailed(id: String, newIdempotencyKey: String)
    @Query("DELETE FROM upload_tasks") suspend fun deleteAll()
    /** Swipe on a queue row (A2): cancels an unfinished task or removes a finished one; the file is untouched. */
    @Query("DELETE FROM upload_tasks WHERE id = :id") suspend fun delete(id: String)
}

@Database(entities = [UploadTaskEntity::class, DraftEntity::class], version = 3, exportSchema = false)
abstract class UploadDatabase : RoomDatabase() {
    abstract fun uploads(): UploadDao
    abstract fun drafts(): DraftDao

    companion object {
        fun open(context: Context): UploadDatabase =
            Room.databaseBuilder(context.applicationContext, UploadDatabase::class.java, "uploads.db").addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()

        /** v2: sessions behind the ingest gate (SEC-07). Existing rows predate the gate. */
        val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE upload_tasks ADD COLUMN ingestTokenRequired INTEGER NOT NULL DEFAULT 0")
            }
        }

        /** v3: the material's priority on the queue row, and A1 drafts (#387). */
        val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE upload_tasks ADD COLUMN priority TEXT")
                db.execSQL("CREATE TABLE IF NOT EXISTS drafts (id TEXT NOT NULL, title TEXT NOT NULL, json TEXT NOT NULL, updatedAtEpochMs INTEGER NOT NULL, PRIMARY KEY(id))")
            }
        }
    }
}

/** Core's queue interface over Room; writes are synchronous commits, as the engine requires. */
class RoomUploadStore(private val dao: UploadDao, private val sealer: KeystoreSealer) : UploadStore {
    override suspend fun get(id: String): UploadTask? = dao.get(id)?.let { toTask(it) }

    override suspend fun save(task: UploadTask) {
        val existing = dao.get(task.id)
        dao.upsert(toEntity(task, title = existing?.title ?: "", localCopyHandled = existing?.localCopyHandled ?: false, priority = existing?.priority))
    }

    override suspend fun pending(): List<UploadTask> = dao.pending().map { toTask(it) }

    /** Queues the task if its id is new; an existing row (same id after a repeated send) keeps its state and progress. */
    suspend fun insert(task: UploadTask, title: String, priority: String? = null) {
        dao.insertIfAbsent(toEntity(task, title, localCopyHandled = false, priority = priority))
    }

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

    private fun toEntity(t: UploadTask, title: String, localCopyHandled: Boolean, priority: String?) = UploadTaskEntity(
        id = t.id, materialId = t.materialId, kind = t.kind, fileUri = t.fileUri, filename = t.filename, mimeType = t.mimeType,
        sizeBytes = t.sizeBytes, idempotencyKey = t.idempotencyKey, createdAtEpochMs = t.createdAtEpochMs, updatedAtEpochMs = t.updatedAtEpochMs,
        state = t.state.name, sha256 = t.sha256, headSha256 = t.headSha256, tailSha256 = t.tailSha256,
        sessionId = t.sessionId, tusEndpoint = t.tusEndpoint, tusUploadUrl = t.tusUploadUrl,
        sealedUploadToken = t.uploadToken?.let { sealer.sealString(it) },
        tokenExpiresAtEpochMs = t.tokenExpiresAtEpochMs, sessionExpiresAtEpochMs = t.sessionExpiresAtEpochMs, partSizeBytes = t.partSizeBytes,
        ingestTokenRequired = t.ingestTokenRequired, bytesConfirmed = t.bytesConfirmed, receiptNumber = t.receiptNumber, failure = t.failure?.name, failureCode = t.failureCode, attempts = t.attempts,
        title = title, localCopyHandled = localCopyHandled, priority = priority,
    )
}
