package net.palpost.library.core.upload

import net.palpost.library.api.apis.UploadsApi
import net.palpost.library.api.infrastructure.ClientException
import net.palpost.library.core.net.IdempotencyKey
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

/** A cancelled row's server session still to end with `DELETE /uploads/{id}` (ADR 0112); its key is fixed once and reused on every retry. */
data class PendingAbort(val sessionId: String, val ownerAccount: String?, val idempotencyKey: String, val createdAtEpochMs: Long)

/** Where pending aborts wait: Room on Android (`upload_aborts`), memory in tests. */
interface AbortStore {
    /** Keeps [abort] unless its session is kept already; false when nothing can be written now. */
    suspend fun add(abort: PendingAbort): Boolean
    /** Oldest first. */
    suspend fun all(): List<PendingAbort>
    suspend fun remove(sessionId: String)
}

class InMemoryAbortStore : AbortStore {
    private val aborts = LinkedHashMap<String, PendingAbort>()
    override suspend fun add(abort: PendingAbort): Boolean = synchronized(aborts) { aborts.putIfAbsent(abort.sessionId, abort); true }
    override suspend fun all(): List<PendingAbort> = synchronized(aborts) { aborts.values.sortedBy { it.createdAtEpochMs } }
    override suspend fun remove(sessionId: String) { synchronized(aborts) { aborts.remove(sessionId) } }
}

/**
 * Cancel on the phone ends the session on the server too (ADR 0112): `DELETE /uploads/{id}` invalidates the upload token and deletes
 * what already arrived, instead of leaving it there until the session lapses. The request goes in the row owner's name alone
 * (ADR 0093); one that cannot go now (offline, server trouble, owner signed out) is kept and sent by a later [drain]: at the start of
 * every run, and at sign-in or launch when no run follows.
 */
class SessionAborts(
    private val store: AbortStore,
    private val uploadsApi: UploadsApi,
    private val mayAct: (ownerAccount: String?) -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newKey: () -> String = IdempotencyKey::generate,
) {
    /**
     * [task] as it was last stored, or as its run last held it. A session that may hold bytes is aborted now or kept for later. A row
     * with no session has nothing on the server to end, and a verified one is not the reporter's to cancel (`409`), only to remove.
     */
    suspend fun abort(task: UploadTask) {
        val session = task.sessionId ?: return
        if (task.state == UploadState.VERIFIED || task.state == UploadState.DEDUPLICATED) return
        val kept = try {
            store.add(PendingAbort(session, task.ownerAccount, newKey(), clock()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        if (kept) drain()
    }

    /**
     * Sends the kept aborts whose owner is signed in, oldest first, and stops at the first that meets trouble (the next would meet
     * it too). Never throws but for cancellation. Returns how many are still kept.
     */
    suspend fun drain(): Int {
        var left = 0
        try {
            val kept = store.all()
            left = kept.size
            for (a in kept) {
                if (!mayAct(a.ownerAccount)) continue
                if (!send(a)) break
                store.remove(a.sessionId)
                left--
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Storage trouble: what is kept stays for the next drain.
        }
        return left
    }

    /** True when the server has the last word on this session (aborted, already gone, or verified meanwhile); false to try again. */
    private suspend fun send(a: PendingAbort): Boolean {
        val id = runCatching { UUID.fromString(a.sessionId) }.getOrNull() ?: return true
        return try {
            uploadsApi.abortUploadSession(a.idempotencyKey, id)
            true
        } catch (e: ClientException) {
            // 401 is a session the client could not refresh and 429 asks to wait: kept. Any other 4xx is final: 404 (gone, or not
            // this account's), 409 (verified meanwhile), 403.
            e.statusCode != 401 && e.statusCode != 429
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false // 5xx, offline, a cut connection
        }
    }
}
