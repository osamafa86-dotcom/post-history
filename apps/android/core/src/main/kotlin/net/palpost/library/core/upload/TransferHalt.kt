package net.palpost.library.core.upload

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * SEC-01: the wipe's hold on a transfer (ADR 0112). Coroutine cancellation does not reach a thread blocked in a tus write or read
 * (HttpURLConnection), and such a thread, once it returns, would write its row back into the database the wipe has just erased.
 *
 * A run captures the [generation] when it starts and works through stores [guard]ed with it. [halt] ends the generation, so those
 * stores read nothing and write nothing from then on, and cuts the connections of the transports registered with [tracking], which
 * ends a blocked call with an IOException at once. [awaitIdle] then waits, bounded, for those runs to return before the queue is
 * erased; a run that outlives the wait still cannot write. A run started after the halt captures the new generation.
 */
class TransferHalt {
    private val generation = AtomicInteger()
    private val running = AtomicInteger()
    private val transports = ConcurrentHashMap.newKeySet<TusTransport>()

    fun generation(): Int = generation.get()

    fun isLive(generation: Int): Boolean = this.generation.get() == generation

    /** [store] as a run of [generation] sees it: empty and read-only once that generation has ended. */
    fun guard(store: UploadStore, generation: Int): UploadStore = object : UploadStore {
        override suspend fun get(id: String): UploadTask? = if (isLive(generation)) store.get(id) else null
        override suspend fun update(task: UploadTask): Boolean = isLive(generation) && store.update(task)
        override suspend fun pending(): List<UploadTask> = if (isLive(generation)) store.pending() else emptyList()
    }

    /** The same for the kept session aborts. */
    fun guard(store: AbortStore, generation: Int): AbortStore = object : AbortStore {
        override suspend fun add(abort: PendingAbort): Boolean = isLive(generation) && store.add(abort)
        override suspend fun all(): List<PendingAbort> = if (isLive(generation)) store.all() else emptyList()
        override suspend fun remove(sessionId: String) { if (isLive(generation)) store.remove(sessionId) }
    }

    /** Runs [block] as one run whose connections a [halt] cuts; [awaitIdle] waits for it. */
    suspend fun <T> tracking(transport: TusTransport, block: suspend () -> T): T {
        transports.add(transport)
        running.incrementAndGet()
        try {
            return block()
        } finally {
            transports.remove(transport)
            running.decrementAndGet()
        }
    }

    /** Ends the generation and cuts every connection of the runs tracked now; returns at once. */
    fun halt() {
        generation.incrementAndGet()
        transports.forEach { it.cutAll() }
    }

    /** True once no tracked run is left; false when [timeoutMs] passed first (the guards hold either way). */
    suspend fun awaitIdle(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) {
        while (running.get() > 0) delay(POLL_MS)
        true
    } ?: false

    private companion object {
        const val POLL_MS = 20L
    }
}
