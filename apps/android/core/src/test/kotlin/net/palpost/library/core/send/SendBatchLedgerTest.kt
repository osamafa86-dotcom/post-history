package net.palpost.library.core.send

import net.palpost.library.core.send.UploadItem.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SendBatchLedgerTest {
    /** A sends file in memory whose reads can fail («unreadable») or be garbage («corrupt»). */
    private class FakeStore(var text: String? = null) : SendBatchStore {
        var unreadable = false
        var writes = 0
        override fun read(): SendBatchRead = when {
            unreadable -> SendBatchRead.Unreadable
            text == null -> SendBatchRead.Batches(emptyList())
            else -> SendBatchCodec.decode(text!!)?.let { SendBatchRead.Batches(it) } ?: SendBatchRead.Corrupt
        }
        override fun write(batches: List<SendBatch>): Boolean {
            if (unreadable) return false
            writes++; text = SendBatchCodec.encode(batches); return true
        }
        override fun clear() { text = null }
    }

    private var ids = 0
    private fun ledger(store: FakeStore) = SendBatchLedger(store) { "b${++ids}" }

    /** Arrival state per material, as the upload screen would count it. */
    private val arrived = HashMap<String, State>()
    private val items: (SendBatch) -> List<UploadItem> = { b -> b.materialIds.map { UploadItem(it, it, 10, 0, arrived[it] ?: State.TRANSFERRING) } }

    @Test
    fun `the send is on disk before the first file is queued, and its receipt waits for the loop to close`() {
        val store = FakeStore()
        val l = ledger(store)
        val b = l.begin("Title", listOf("k1", "k2"), sensitive = false, owner = "acc", nowMs = 1)
        assertEquals(listOf("k1", "k2"), SendBatchCodec.decode(store.text!!)!!.single().fileKeys)
        l.add("m1", b.id)
        arrived["m1"] = State.ARRIVED
        // A small file verified while the loop runs gets no receipt of its own.
        assertNull(l.receiptDueForMaterial("m1", items))
        l.add("m2", b.id)
        arrived["m2"] = State.ARRIVED
        l.finish(b.id, listOf("m1", "m2"))
        assertEquals(SendBatchLedger.ReceiptScope.Batch(b.id), l.receiptDueForBatch(b.id, items))
        l.markReceiptShown(b.id)
        assertNull(l.receiptDueForMaterial("m2", items))
        assertTrue(SendBatchCodec.decode(store.text!!)!!.single().receiptShown)
    }

    @Test
    fun `a partly failed send keeps what was queued, and one with nothing queued is dropped`() {
        val l = ledger(FakeStore())
        val partial = l.begin("A", listOf("k1", "k2"), null, null, 1)
        l.add("m1", partial.id)
        l.finish(partial.id, listOf("m1"))
        val none = l.begin("B", listOf("k3"), null, null, 2)
        l.finish(none.id, emptyList())
        assertEquals(listOf(partial.id), l.batches.map { it.id })
        assertEquals(listOf("m1"), l.batches.single().materialIds)
    }

    @Test
    fun `a material outside any send gets its own receipt`() {
        assertEquals(SendBatchLedger.ReceiptScope.Material("x"), ledger(FakeStore()).receiptDueForMaterial("x", items))
    }

    @Test
    fun `a send cut by the process dying counts as closed in the next process`() {
        val store = FakeStore()
        val first = ledger(store)
        val b = first.begin("A", listOf("k1"), null, null, 1)
        first.add("m1", b.id)
        arrived["m1"] = State.ARRIVED
        val next = ledger(store)
        assertFalse(next.isOpen(b.id))
        assertEquals(SendBatchLedger.ReceiptScope.Batch(b.id), next.receiptDueForMaterial("m1", items))
    }

    @Test
    fun `a failed read never erases the list, and a change before the first read is merged into the file`() {
        val store = FakeStore()
        val seed = ledger(store)
        seed.finish(seed.begin("Old", listOf("k"), null, null, 1).id.also { seed.add("m0", it) }, listOf("m0"))
        store.unreadable = true
        val l = ledger(store)
        assertTrue(l.batches.isEmpty())
        val fresh = l.begin("New", listOf("k2"), null, null, 5)
        l.add("m9", fresh.id)
        l.refresh()
        assertEquals(listOf(fresh.id), l.batches.map { it.id })
        store.unreadable = false
        l.refresh()
        assertEquals(listOf("New", "Old"), l.batches.map { it.title })
        assertEquals(listOf("New", "Old"), SendBatchCodec.decode(store.text!!)!!.map { it.title })
    }

    @Test
    fun `a corrupt file is replaced by the state in memory`() {
        val store = FakeStore("{oops")
        val l = ledger(store)
        l.begin("A", listOf("k"), null, null, 1)
        assertEquals(listOf("A"), SendBatchCodec.decode(store.text!!)!!.map { it.title })
    }

    @Test
    fun `the list keeps the newest 30, receipts due wait for their owner, and forgetting clears the file`() {
        val store = FakeStore()
        val l = ledger(store)
        repeat(35) { i -> val b = l.begin("t$i", listOf("k$i"), null, if (i % 2 == 0) "a" else "b", i.toLong()); l.add("m$i", b.id); l.finish(b.id, listOf("m$i")) }
        assertEquals(SendBatchLedger.LIMIT, l.batches.size)
        assertEquals("t34", l.batches.first().title)
        arrived["m33"] = State.ARRIVED
        arrived["m34"] = State.ARRIVED
        arrived["m32"] = State.ARRIVED
        val dueForA = l.receiptsDue("a", items).map { id -> l.batches.first { it.id == id }.title }
        assertEquals(listOf("t32", "t34"), dueForA)
        assertEquals(listOf("t33"), l.receiptsDue("b", items).map { id -> l.batches.first { it.id == id }.title })
        l.forgetAll()
        assertTrue(l.batches.isEmpty())
        assertNull(store.text)
    }

    @Test
    fun `the codec keeps every field and refuses what it does not understand`() {
        val b = SendBatch("id", "T", listOf("k"), listOf("m"), 7, receiptShown = true, sensitive = true, owner = "o")
        assertEquals(listOf(b), SendBatchCodec.decode(SendBatchCodec.encode(listOf(b))))
        assertNull(SendBatchCodec.decode("[{\"id\":1}]"))
        assertEquals(emptyList<SendBatch>(), SendBatchCodec.decode("[]"))
    }
}
