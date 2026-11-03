package net.palpost.library.core.materials

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialPage
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

/** `GET /materials` as the reporter needs it: their own materials (scoped by the server), newest first, in pages. */
interface MaterialsListApi {
    suspend fun page(cursor: String?, limit: Int): MaterialPage
    suspend fun material(id: UUID): Material
}

/**
 * My materials as a list (ADR 0089, iOS `MaterialsFeed`): a refresh from the top and the next page without repeats. Loads (pull,
 * poll and «next page») run one at a time in arrival order, behind a fair lock: one asked for while another runs waits its turn
 * and then runs, and never returns without a request; so a «next page» that meets a poll is not lost. A load asked for before a
 * clear, or cancelled while it waits, falls without a request.
 */
class MaterialsFeed(private val api: MaterialsListApi, private val pageSize: Int = 30) {
    private val turn = Mutex()
    private val state = Any()
    @Volatile private var epoch = 0
    private var _items: List<Material> = emptyList()
    private var nextCursor: String? = null
    private var reachedEnd = false
    /** A first page arrived since the last clear; without it the list may hold only a [reload], with no cursor or end. */
    private var pageLoaded = false

    val items: List<Material> get() = synchronized(state) { _items }

    /** The pages' progress, the key of «next page» at the gallery's end: it changes only with a request that was sent. */
    val progress: PageProgress get() = synchronized(state) { PageProgress(nextCursor, reachedEnd, pageLoaded) }

    /** At its turn and before the request: one asked for before a clear falls (false), one cancelled while waiting throws. */
    private suspend fun stillWanted(started: Int): Boolean {
        if (started != epoch) return false
        currentCoroutineContext().ensureActive()
        return true
    }

    /** The first page again, dropping what came after (pull to refresh, first load). The previous list stays if it fails. */
    suspend fun refresh(): List<Material> {
        val started = epoch
        return turn.withLock { if (!stillWanted(started)) items else firstPage(started) }
    }

    private suspend fun firstPage(started: Int): List<Material> {
        val page = api.page(null, pageSize)
        synchronized(state) {
            if (started != epoch) return _items
            _items = page.items
            nextCursor = page.nextCursor
            reachedEnd = page.nextCursor == null
            pageLoaded = true
            return _items
        }
    }

    /**
     * The poll and coming back to the gallery: the first page merges over what was loaded, so the gallery keeps its pages and its
     * place. What changed is updated in place and what is new goes on top; what follows and its cursor stay. The whole list is
     * replaced when the first page is the whole list (no cursor after it, so deleted ones drop too), or when it shares nothing with
     * what was loaded and has a cursor after it (more than a page of new ones). Before any page it is a first load.
     */
    suspend fun refreshHead(): List<Material> {
        val started = epoch
        return turn.withLock {
            if (!stillWanted(started)) return@withLock items
            if (!synchronized(state) { pageLoaded && _items.isNotEmpty() }) return@withLock firstPage(started)
            val page = api.page(null, pageSize)
            synchronized(state) {
                if (started != epoch) return@withLock _items
                val known = _items.map { it.id }.toSet()
                if (page.nextCursor == null || page.items.none { it.id in known }) {
                    _items = page.items
                    nextCursor = page.nextCursor
                    reachedEnd = page.nextCursor == null
                } else {
                    val fresh = page.items.associateBy { it.id }
                    val added = page.items.filter { it.id !in known }.distinctBy { it.id }
                    _items = added + _items.map { fresh[it.id] ?: it }
                }
                _items
            }
        }
    }

    /** The next page; what arrives twice is not repeated. A running load (a poll) is waited for, then this asks with its cursor. */
    suspend fun loadMore(): List<Material> {
        val started = epoch
        return turn.withLock {
            if (!stillWanted(started)) return@withLock items
            if (!synchronized(state) { pageLoaded }) return@withLock firstPage(started)
            val cursor = synchronized(state) { if (reachedEnd) null else nextCursor } ?: return@withLock items
            val page = api.page(cursor, pageSize)
            synchronized(state) {
                if (started != epoch) return@withLock _items
                val known = _items.map { it.id }.toSet()
                _items = _items + page.items.filter { it.id !in known }
                nextCursor = page.nextCursor
                reachedEnd = page.nextCursor == null
                _items
            }
        }
    }

    /** One material updated in place (the detail, or a notification about it). */
    suspend fun reload(id: UUID): Material {
        val started = epoch
        val m = api.material(id)
        synchronized(state) {
            if (started != epoch) return m
            _items = if (_items.any { it.id == id }) _items.map { if (it.id == id) m else it } else listOf(m) + _items
        }
        return m
    }

    /** The emergency wipe and sign-out: no title or place stays in memory, and loads started before fall. */
    fun clear() = synchronized(state) {
        epoch++
        _items = emptyList()
        nextCursor = null
        reachedEnd = false
        pageLoaded = false
    }
}

/**
 * The pages' progress and the «next page» decision at the gallery's end (ADR 0089). The end row's key changes only with a request
 * that was sent, so its task neither comes back without a request nor spins.
 */
data class PageProgress(val cursor: String? = null, val reachedEnd: Boolean = false, val started: Boolean = false, val failed: Boolean = false) {
    /**
     * Ask for the next page now? Not while one is on its way or queued ([pending]), not after the last page, not after a failure
     * unless the reporter asks ([retry]), not after a first page with no cursor. Before any page yes: `loadMore` is then a first load.
     */
    fun wantsNextPage(pending: Boolean, retry: Boolean = false): Boolean {
        if (pending || reachedEnd || (failed && !retry)) return false
        return cursor != null || !started
    }
}

/** A cancellation is not a failure: no «not updated since», no «load more», no «nothing matches» before their time. */
object LoadOutcome {
    fun isCancellation(e: Throwable): Boolean {
        var t: Throwable? = e
        var depth = 0
        while (t != null && depth < 8) {
            if (t is CancellationException) return true
            // OkHttp's cancelled call (the generated client lets it through as is).
            if (t is IOException && t.message.equals("Canceled", ignoreCase = true)) return true
            t = t.cause
            depth++
        }
        return false
    }
}

/**
 * What My materials shows from the list (iOS `MaterialsListState`): the materials, the pages' progress, the last good update, and
 * a generation that rises with the emergency wipe, sign-out and revocation. Each load takes its generation's ticket when it starts,
 * before any wait, and its result falls if the generation rose since: a list that came back before the clear is never written
 * after it, so the previous reporter's titles and places never come back to memory.
 */
class MaterialsListState {
    data class Ticket internal constructor(val generation: Int)

    var items: List<Material> = emptyList(); private set
    var pages: PageProgress = PageProgress(); private set
    var lastUpdatedEpochMs: Long? = null; private set
    private var generation = 0

    fun ticket(): Ticket = Ticket(generation)

    fun accepts(t: Ticket): Boolean = t.generation == generation

    /**
     * A load's result with the pages' progress after it. Success writes the materials and clears the failure (and [updatedAtMs] for
     * the first page only); a cancellation changes nothing; a failure keeps what is shown. False when the result fell to a clear.
     */
    fun settle(t: Ticket, result: Result<List<Material>>, progress: PageProgress, updatedAtMs: Long? = null): Boolean {
        if (!accepts(t)) return false
        val error = result.exceptionOrNull()
        pages = when {
            error == null -> { items = result.getOrThrow(); if (updatedAtMs != null) lastUpdatedEpochMs = updatedAtMs; progress.copy(failed = false) }
            LoadOutcome.isCancellation(error) -> progress.copy(failed = pages.failed)
            else -> progress.copy(failed = true)
        }
        return true
    }

    /** One material updated ([MaterialsFeed.reload]): the materials as the feed holds them after it, unless a clear came since. */
    fun replaceItems(t: Ticket, fresh: List<Material>): Boolean {
        if (!accepts(t)) return false
        items = fresh
        return true
    }

    fun clear() {
        generation++
        items = emptyList()
        pages = PageProgress()
        lastUpdatedEpochMs = null
    }
}
