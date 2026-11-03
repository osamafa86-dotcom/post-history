package net.palpost.library.core.send

import com.squareup.moshi.Types
import net.palpost.library.api.infrastructure.Serializer

/**
 * One send from the send screen: its base title, the create keys of its files as planned before the first request, and the
 * materials of the files that entered the queue, so one receipt and one set of rings cover them (ADR 0088), as on iOS.
 */
data class SendBatch(
    val id: String,
    val title: String,
    /** The `Idempotency-Key` creating each file, in send order, recorded before the first `POST /materials`. */
    val fileKeys: List<String> = emptyList(),
    /** Materials of the files that entered the queue; each is added here before its file is queued. */
    val materialIds: List<String> = emptyList(),
    val createdAtEpochMs: Long,
    val receiptShown: Boolean = false,
    /** The send's sensitivity answer («Yes» in any of the three): its thumbnails stay concealed until the material is known. */
    val sensitive: Boolean? = null,
    /** The opaque local id of the account that sent it (ADR 0093); null for a file an earlier build wrote. */
    val owner: String? = null,
)

/** The read of the sends file: «no file» is a true empty list, and «unreadable» is not «no sends». */
sealed interface SendBatchRead {
    data class Batches(val batches: List<SendBatch>) : SendBatchRead
    /** The file is there and could not be read now; read again later. */
    data object Unreadable : SendBatchRead
    /** Read and not understood: what is in it cannot come back, and the last good state in memory is written over it. */
    data object Corrupt : SendBatchRead
}

/** The sends file on the phone (`send-batches.json`, out of backups; the emergency wipe and revocation erase it). Keeps the last 30. */
interface SendBatchStore {
    fun read(): SendBatchRead
    fun write(batches: List<SendBatch>): Boolean
    fun clear()
}

/** JSON of the sends file; null when it is not understood. */
object SendBatchCodec {
    private val adapter = Serializer.moshi.adapter<List<Map<String, Any?>>>(
        Types.newParameterizedType(List::class.java, Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)),
    ).serializeNulls()

    fun encode(batches: List<SendBatch>): String = adapter.toJson(
        batches.map { b ->
            mapOf(
                "id" to b.id, "title" to b.title, "fileKeys" to b.fileKeys, "materialIds" to b.materialIds, "createdAt" to b.createdAtEpochMs,
                "receiptShown" to b.receiptShown, "sensitive" to b.sensitive, "owner" to b.owner,
            )
        },
    )

    fun decode(json: String): List<SendBatch>? = runCatching {
        adapter.fromJson(json)!!.map { m ->
            SendBatch(
                id = m["id"] as String,
                title = m["title"] as String,
                fileKeys = (m["fileKeys"] as? List<*>)?.filterIsInstance<String>().orEmpty(),
                materialIds = (m["materialIds"] as List<*>).filterIsInstance<String>(),
                createdAtEpochMs = (m["createdAt"] as Number).toLong(),
                receiptShown = m["receiptShown"] as Boolean,
                sensitive = m["sensitive"] as? Boolean,
                owner = m["owner"] as? String,
            )
        }
    }.getOrNull()
}

/**
 * The sends as the screens see them: the last good state in memory over [SendBatchStore], newest first (iOS `SendBatchLedger`).
 * - A failed read never erases the list in memory; it stays and the read is tried again at the next refresh.
 * - A change made before the file was first read in this process stays in memory and is merged into the file at the first
 *   successful read, so it never wipes sends it does not know.
 * - A send whose loop is still running in this process shows no receipt until it closes, so a small file that arrives first
 *   does not get a receipt of its own. A send whose loop was cut by the process dying counts as closed in the next process.
 */
class SendBatchLedger(val store: SendBatchStore, private val newId: () -> String = { java.util.UUID.randomUUID().toString() }) {
    sealed interface ReceiptScope {
        /** A material outside any send (a replacement shot, or from an earlier build): its own receipt as before. */
        data class Material(val materialId: String) : ReceiptScope
        /** The whole send: one receipt when everything left of it has arrived. */
        data class Batch(val batchId: String) : ReceiptScope
    }

    private val lock = Any()
    private var _batches: List<SendBatch> = emptyList()
    val batches: List<SendBatch> get() = synchronized(lock) { _batches }
    private var synced = false
    private var unsaved = false
    private val open = HashSet<String>()

    init { refresh() }

    /** Reads the file when possible: success replaces the list (merged with what was not saved), failure keeps the last good one. */
    fun refresh(): List<SendBatch> = synchronized(lock) {
        when (val r = store.read()) {
            is SendBatchRead.Batches -> {
                _batches = if (unsaved) merge(_batches, r.batches) else newestFirst(r.batches)
                synced = true
                if (unsaved) unsaved = !store.write(_batches)
            }
            SendBatchRead.Corrupt -> { synced = true; unsaved = !store.write(_batches) }
            SendBatchRead.Unreadable -> Unit
        }
        _batches
    }

    fun isOpen(id: String): Boolean = synchronized(lock) { id in open }

    fun batchContaining(materialId: String): SendBatch? = synchronized(lock) { _batches.firstOrNull { materialId in it.materialIds } }

    /** Before the first `POST /materials`: the send with its id and its files' keys, open until [finish]. */
    fun begin(title: String, fileKeys: List<String>, sensitive: Boolean?, owner: String?, nowMs: Long): SendBatch = synchronized(lock) {
        val batch = SendBatch(newId(), title, fileKeys, emptyList(), nowMs, sensitive = sensitive, owner = owner)
        _batches = listOf(batch) + _batches
        open.add(batch.id)
        commit()
        batch
    }

    /** A file's material was created: it joins its send before the file enters the queue. */
    fun add(materialId: String, batchId: String) = synchronized(lock) {
        val b = _batches.firstOrNull { it.id == batchId } ?: return@synchronized
        if (materialId in b.materialIds) return@synchronized
        _batches = _batches.map { if (it.id == batchId) it.copy(materialIds = it.materialIds + materialId) else it }
        commit()
    }

    /** The send loop ended (whole or partly failed): only the materials that entered the queue stay; a send with none is dropped. */
    fun finish(batchId: String, queued: List<String>) = synchronized(lock) {
        open.remove(batchId)
        if (_batches.none { it.id == batchId }) return@synchronized
        _batches = if (queued.isEmpty()) _batches.filterNot { it.id == batchId } else _batches.map { if (it.id == batchId) it.copy(materialIds = queued) else it }
        commit()
    }

    /** The send's receipt was shown: marked in memory first (never shown twice even if saving fails), then saved. */
    fun markReceiptShown(batchId: String) = synchronized(lock) {
        val b = _batches.firstOrNull { it.id == batchId } ?: return@synchronized
        if (b.receiptShown) return@synchronized
        _batches = _batches.map { if (it.id == batchId) it.copy(receiptShown = true) else it }
        commit()
    }

    /**
     * Sends of [owner] whose receipt became due while they were out (their last file arrived) and was not shown, oldest first:
     * shown when they sign in (ADR 0093). Sends of earlier builds, with no owner, are not listed, so no old receipt pops up.
     */
    fun receiptsDue(owner: String, items: (SendBatch) -> List<UploadItem>): List<String> = synchronized(lock) {
        _batches.filter { it.owner == owner && due(it, items) != null }.reversed().map { it.id }
    }

    /** Revocation and the emergency wipe (and sign-out): no sends pointing at a queue that is gone. */
    fun forgetAll() = synchronized(lock) {
        _batches = emptyList()
        open.clear()
        unsaved = false
        synced = true
        store.clear()
    }

    /**
     * When a material's original is verified: its own receipt when it is outside any send, the send's receipt when the send is
     * complete, closed and not shown yet, else null (it waits). [items]: the send's originals as the upload screen counts them.
     */
    fun receiptDueForMaterial(materialId: String, items: (SendBatch) -> List<UploadItem>): ReceiptScope? = synchronized(lock) {
        val batch = _batches.firstOrNull { materialId in it.materialIds } ?: return@synchronized ReceiptScope.Material(materialId)
        due(batch, items)
    }

    /** After [finish]: every file of the send may have arrived during the loop, and no later event would bring its receipt. */
    fun receiptDueForBatch(id: String, items: (SendBatch) -> List<UploadItem>): ReceiptScope? = synchronized(lock) {
        _batches.firstOrNull { it.id == id }?.let { due(it, items) }
    }

    private fun due(batch: SendBatch, items: (SendBatch) -> List<UploadItem>): ReceiptScope? {
        if (batch.receiptShown || batch.id in open || !UploadOverview.isComplete(items(batch))) return null
        return ReceiptScope.Batch(batch.id)
    }

    private fun commit() {
        _batches = newestFirst(_batches).take(LIMIT)
        unsaved = true
        if (!synced) { refresh(); return }
        unsaved = !store.write(_batches)
    }

    companion object {
        const val LIMIT = 30

        fun newestFirst(batches: List<SendBatch>): List<SendBatch> = batches.sortedByDescending { it.createdAtEpochMs }

        /** Memory wins for what it knows (it is the newest in this process); what only the file has is added. */
        fun merge(memory: List<SendBatch>, disk: List<SendBatch>): List<SendBatch> {
            val known = memory.map { it.id }.toSet()
            return newestFirst(memory + disk.filter { it.id !in known }).take(LIMIT)
        }
    }
}
