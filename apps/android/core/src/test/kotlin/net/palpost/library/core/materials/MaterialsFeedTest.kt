package net.palpost.library.core.materials

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialPage
import net.palpost.library.core.materials.Fixtures.material
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

class MaterialsFeedTest {
    /** Pages by cursor; each request can be held until the test lets it go. */
    private class FakeApi : MaterialsListApi {
        val pages = HashMap<String?, MaterialPage>()
        val requests = ArrayList<String?>()
        val gates = HashMap<String?, CompletableDeferred<Unit>>()
        override suspend fun page(cursor: String?, limit: Int): MaterialPage {
            requests.add(cursor)
            gates[cursor]?.await()
            return pages.getValue(cursor)
        }
        override suspend fun material(id: UUID): Material = pages.values.flatMap { it.items }.first { it.id == id }
    }

    private val m = (1..6).map { material(it) }

    @Test
    fun `a next page asked during a slow poll is not lost and runs after it with the cursor`() = runTest {
        val api = FakeApi()
        api.pages[null] = MaterialPage(listOf(m[5], m[4]), "p2")
        api.pages["p2"] = MaterialPage(listOf(m[3], m[2]), null)
        val feed = MaterialsFeed(api, pageSize = 2)
        feed.refresh()
        api.gates[null] = CompletableDeferred()
        val poll = async(start = CoroutineStart.UNDISPATCHED) { feed.refreshHead() }
        val more = async(start = CoroutineStart.UNDISPATCHED) { feed.loadMore() }
        yield()
        assertEquals(listOf(null, null), api.requests)
        api.gates.getValue(null).complete(Unit)
        poll.await(); more.await()
        assertEquals(listOf(null, null, "p2"), api.requests)
        assertEquals(listOf(m[5], m[4], m[3], m[2]).map { it.id }, feed.items.map { it.id })
        assertTrue(feed.progress.reachedEnd)
    }

    @Test
    fun `the poll merges the first page without dropping loaded pages or the cursor`() = runTest {
        val api = FakeApi()
        api.pages[null] = MaterialPage(listOf(m[3], m[2]), "p2")
        api.pages["p2"] = MaterialPage(listOf(m[1]), "p3")
        val feed = MaterialsFeed(api, pageSize = 2)
        feed.refresh(); feed.loadMore()
        api.pages[null] = MaterialPage(listOf(m[4], m[3]), "p2")
        feed.refreshHead()
        assertEquals(listOf(m[4], m[3], m[2], m[1]).map { it.id }, feed.items.map { it.id })
        assertEquals("p3", feed.progress.cursor)
        // The first page is the whole list now: it replaces everything (the deleted ones drop).
        api.pages[null] = MaterialPage(listOf(m[5]), null)
        feed.refreshHead()
        assertEquals(listOf(m[5].id), feed.items.map { it.id })
        assertTrue(feed.progress.reachedEnd)
    }

    @Test
    fun `a load asked before a clear never asks after it, nor brings back what was erased`() = runTest {
        val api = FakeApi()
        api.pages[null] = MaterialPage(listOf(m[1]), null)
        val feed = MaterialsFeed(api)
        api.gates[null] = CompletableDeferred()
        val first = async(start = CoroutineStart.UNDISPATCHED) { feed.refresh() }
        val queued = async(start = CoroutineStart.UNDISPATCHED) { feed.loadMore() }
        feed.clear()
        api.gates.getValue(null).complete(Unit)
        first.await(); queued.await()
        assertEquals(listOf<String?>(null), api.requests)
        assertTrue(feed.items.isEmpty())
        assertFalse(feed.progress.started)
    }

    @Test
    fun `a load cancelled while it waits its turn sends nothing`() = runTest {
        val api = FakeApi()
        api.pages[null] = MaterialPage(listOf(m[1]), "p2")
        val feed = MaterialsFeed(api)
        api.gates[null] = CompletableDeferred()
        val first = async(start = CoroutineStart.UNDISPATCHED) { feed.refresh() }
        val waiting = async(start = CoroutineStart.UNDISPATCHED) { feed.refreshHead() }
        waiting.cancel()
        api.gates.getValue(null).complete(Unit)
        first.await()
        assertEquals(listOf<String?>(null), api.requests)
    }

    @Test
    fun `before any page, the next page is a first load`() = runTest {
        val api = FakeApi()
        api.pages[null] = MaterialPage(listOf(m[2]), "p2")
        val feed = MaterialsFeed(api)
        feed.loadMore()
        assertEquals("p2", feed.progress.cursor)
        assertTrue(feed.progress.started)
    }

    @Test
    fun `the next page is asked once, never after the end, and after a failure only on request`() {
        assertTrue(PageProgress().wantsNextPage(pending = false))
        assertFalse(PageProgress("c", started = true).wantsNextPage(pending = true))
        assertTrue(PageProgress("c", started = true).wantsNextPage(pending = false))
        assertFalse(PageProgress(null, reachedEnd = true, started = true).wantsNextPage(pending = false))
        assertFalse(PageProgress("c", started = true, failed = true).wantsNextPage(pending = false))
        assertTrue(PageProgress("c", started = true, failed = true).wantsNextPage(pending = false, retry = true))
        assertFalse(PageProgress(null, started = true).wantsNextPage(pending = false))
    }

    @Test
    fun `cancellation is not a failure, wrapped or not`() {
        assertTrue(LoadOutcome.isCancellation(CancellationException("x")))
        assertTrue(LoadOutcome.isCancellation(IOException("Canceled")))
        assertTrue(LoadOutcome.isCancellation(RuntimeException(IOException("Canceled"))))
        assertFalse(LoadOutcome.isCancellation(IOException("timeout")))
    }

    @Test
    fun `results that started before a clear are dropped, and a failure keeps what is shown`() {
        val s = MaterialsListState()
        val before = s.ticket()
        assertTrue(s.settle(before, Result.success(listOf(m[1])), PageProgress("c", started = true), updatedAtMs = 10))
        assertEquals(10L, s.lastUpdatedEpochMs)
        val stale = s.ticket()
        s.clear()
        assertFalse(s.settle(stale, Result.success(listOf(m[2])), PageProgress("c", started = true), updatedAtMs = 20))
        assertTrue(s.items.isEmpty())
        assertNull(s.lastUpdatedEpochMs)
        assertFalse(s.replaceItems(stale, listOf(m[3])))
        val now = s.ticket()
        s.settle(now, Result.success(listOf(m[4])), PageProgress("c", started = true))
        s.settle(now, Result.failure(IOException("offline")), PageProgress("c", started = true))
        assertEquals(listOf(m[4]), s.items)
        assertTrue(s.pages.failed)
        s.settle(now, Result.failure(CancellationException()), PageProgress("c", started = true))
        assertTrue(s.pages.failed)
    }
}
