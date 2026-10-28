package net.palpost.library.ui.material

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class MaterialBatchTest {
    private fun file(n: Int, created: String? = null) =
        PickedOriginal("content://f/$n", "clip$n.mp4", 1_000L * n, "video/mp4", materialKey = "key-$n", createdMaterialId = created, position = n, total = 5)

    /** A server and a queue that remember what they were asked, and can be told to fail once at a given call. */
    private class Fake {
        val createdKeys = ArrayList<String>()
        val queued = ArrayList<String>() // material ids
        var failCreateAt: String? = null
        var failEnqueueAt: String? = null

        suspend fun create(f: PickedOriginal): String {
            if (f.materialKey == failCreateAt) { failCreateAt = null; throw IOException("network") }
            createdKeys.add(f.materialKey!!)
            return "m-" + f.materialKey
        }

        suspend fun enqueue(f: PickedOriginal, materialId: String): String {
            if (f.materialKey == failEnqueueAt) { failEnqueueAt = null; throw IOException("disk") }
            queued.add(materialId)
            return UploadIds.taskId(materialId)
        }
    }

    @Test
    fun `every file gets its own material and its own row, in order`() = runBlocking {
        val fake = Fake()
        val r = MaterialBatch.run((1..3).map { file(it) }, fake::create, fake::enqueue)
        assertNull(r.failure)
        assertTrue(r.remaining.isEmpty())
        assertEquals(listOf("key-1", "key-2", "key-3"), fake.createdKeys)
        assertEquals(listOf("m-key-1", "m-key-2", "m-key-3"), fake.queued)
        assertEquals(fake.queued.map { UploadIds.taskId(it) }, r.queuedTaskIds)
    }

    @Test
    fun `a failure leaves the failed file and the rest, and a retry finishes without repeating anything`() = runBlocking {
        val fake = Fake()
        fake.failCreateAt = "key-3"
        val progress = ArrayList<List<String>>()
        val first = MaterialBatch.run((1..5).map { file(it) }, fake::create, fake::enqueue) { progress.add(it.map { f -> f.uri }) }
        assertTrue(first.failure is IOException)
        assertEquals(listOf(3, 4, 5).map { file(it) }, first.remaining) // 1 and 2 are out of the draft, 3 had no material yet
        assertEquals(listOf("m-key-1", "m-key-2"), fake.queued)
        assertEquals(2, first.queuedTaskIds.size)
        assertEquals(listOf("content://f/3", "content://f/4", "content://f/5"), progress.last())

        val second = MaterialBatch.run(first.remaining, fake::create, fake::enqueue)
        assertNull(second.failure)
        assertTrue(second.remaining.isEmpty())
        assertEquals(listOf("key-1", "key-2", "key-3", "key-4", "key-5"), fake.createdKeys) // each material created once
        assertEquals((1..5).map { "m-key-$it" }, fake.queued) // each file queued once
    }

    @Test
    fun `a file whose material was created but whose row failed keeps the material id and is not created again`() = runBlocking {
        val fake = Fake()
        fake.failEnqueueAt = "key-2"
        val first = MaterialBatch.run((1..3).map { file(it) }, fake::create, fake::enqueue)
        assertTrue(first.failure is IOException)
        assertEquals(listOf(file(2, created = "m-key-2"), file(3)), first.remaining)
        assertEquals(listOf("key-1", "key-2"), fake.createdKeys)

        val second = MaterialBatch.run(first.remaining, fake::create, fake::enqueue)
        assertNull(second.failure)
        assertEquals(listOf("key-1", "key-2", "key-3"), fake.createdKeys) // key-2 was not sent a second time
        assertEquals(listOf("m-key-1", "m-key-2", "m-key-3"), fake.queued)
    }

    @Test
    fun `the remaining files survive the draft round trip with their material ids`() = runBlocking {
        val fake = Fake()
        fake.failEnqueueAt = "key-2"
        val first = MaterialBatch.run((1..3).map { file(it) }, fake::create, fake::enqueue)
        val draft = MaterialDraft(files = first.remaining, step = 4)
        val reloaded = MaterialDraft.fromJson(draft.toJson())!!
        assertEquals(first.remaining, reloaded.files)
        val second = MaterialBatch.run(reloaded.files, fake::create, fake::enqueue)
        assertNull(second.failure)
        assertEquals(listOf("key-1", "key-2", "key-3"), fake.createdKeys)
        assertEquals(3, fake.queued.size)
    }

    @Test
    fun `a failure on the very first file leaves everything in place`() = runBlocking {
        val fake = Fake()
        fake.failCreateAt = "key-1"
        val files = (1..2).map { file(it) }
        val r = MaterialBatch.run(files, fake::create, fake::enqueue)
        assertEquals(files, r.remaining)
        assertTrue(r.queuedTaskIds.isEmpty())
        assertTrue(fake.createdKeys.isEmpty())
    }

    @Test
    fun `the draft is saved before the first request, with the material id before its row is queued, and the file is dropped after`() = runBlocking {
        val events = ArrayList<String>()
        val files = (1..2).map { file(it) }
        val r = MaterialBatch.run(
            files,
            createMaterial = { f -> events.add("create:${f.position}"); "m-${f.materialKey}" },
            enqueue = { f, id -> events.add("enqueue:${f.position}:$id"); UploadIds.taskId(id) },
            persist = { rest ->
                // What the draft would hold at this moment: each remaining file, marked with its material id when it has one.
                events.add("draft:" + rest.joinToString(",") { "${it.position}${it.createdMaterialId?.let { id -> "=$id" } ?: ""}" })
            },
        )
        assertNull(r.failure)
        assertEquals(
            listOf(
                "draft:1,2", // before anything is sent: details and keys are already safe
                "create:1", "draft:1=m-key-1,2", // the id is saved before the file is queued
                "enqueue:1:m-key-1", "draft:2", // the file leaves the draft only after its row exists
                "create:2", "draft:2=m-key-2",
                "enqueue:2:m-key-2", "draft:",
            ),
            events,
        )
    }

    @Test
    fun `a process killed after the id was saved resumes from that draft without creating the material again`() = runBlocking {
        val fake = Fake()
        var lastDraft: List<PickedOriginal> = emptyList()
        // The "process" dies the moment the draft holding the id has been written, before the row is queued.
        val killed = try {
            MaterialBatch.run(
                (1..3).map { file(it) }, fake::create, fake::enqueue,
                persist = { rest -> lastDraft = rest; if (rest.firstOrNull()?.createdMaterialId != null) throw IllegalStateException("killed") },
            )
        } catch (e: IllegalStateException) { null }
        // run() reports the failure as a result instead of throwing; either way only the saved draft survives the "crash".
        assertTrue(killed == null || killed.failure is IllegalStateException)
        assertEquals(file(1, created = "m-key-1"), lastDraft.first())
        assertEquals(listOf("key-1"), fake.createdKeys)
        assertTrue(fake.queued.isEmpty())

        val resumed = MaterialBatch.run(MaterialDraft.fromJson(MaterialDraft(files = lastDraft).toJson())!!.files, fake::create, fake::enqueue)
        assertNull(resumed.failure)
        assertEquals(listOf("key-1", "key-2", "key-3"), fake.createdKeys) // key-1 was created once, in the first life
        assertEquals((1..3).map { "m-key-$it" }, fake.queued)
    }
}
