package net.palpost.library.core.send

import net.palpost.library.core.send.UploadItem.State
import net.palpost.library.core.upload.UploadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadOverviewTest {
    private fun item(size: Long, done: Long, state: State, paused: Boolean = false, preview: Boolean = false) =
        UploadItem("i$size$done", "m", size, done, state, paused, preview)

    @Test
    fun `the fraction is weighted by size, arrived counts whole and cancelled is left out`() {
        val items = listOf(item(300, 0, State.ARRIVED), item(100, 50, State.TRANSFERRING), item(1000, 10, State.CANCELLED))
        assertEquals(350.0 / 400.0, UploadOverview.fraction(items), 1e-9)
        assertEquals(0.0, UploadOverview.fraction(emptyList()), 0.0)
        assertEquals(1.0, UploadOverview.fraction(listOf(item(0, 0, State.ARRIVED))), 0.0)
        assertEquals(1.0, UploadOverview.fraction(listOf(item(10, 99, State.TRANSFERRING))), 0.0)
    }

    @Test
    fun `rings pulse, calm, fill and turn red`() {
        assertEquals(UploadOverview.RingState.UPLOADING, UploadOverview.ringState(listOf(item(1, 0, State.TRANSFERRING)), online = true))
        assertEquals(UploadOverview.RingState.WAITING, UploadOverview.ringState(listOf(item(1, 0, State.TRANSFERRING)), online = false))
        assertEquals(UploadOverview.RingState.WAITING, UploadOverview.ringState(listOf(item(1, 0, State.PREPARING, paused = true)), online = true))
        assertEquals(UploadOverview.RingState.DONE, UploadOverview.ringState(listOf(item(1, 1, State.ARRIVED)), online = false))
        assertEquals(UploadOverview.RingState.FAILED, UploadOverview.ringState(listOf(item(1, 1, State.ARRIVED), item(2, 0, State.FAILED)), online = true))
        assertEquals(UploadOverview.RingState.WAITING, UploadOverview.ringState(emptyList(), online = true))
    }

    @Test
    fun `stages never claim the backup, and the send is complete when everything left arrived`() {
        assertEquals(UploadStage.ORIGINAL, UploadOverview.stage(item(1, 1, State.ARRIVED)))
        assertEquals(UploadStage.PREVIEW, UploadOverview.stage(item(1, 0, State.TRANSFERRING, preview = true)))
        assertEquals(UploadStage.NONE, UploadOverview.stage(item(1, 0, State.FINISHING)))
        assertEquals(1, UploadOverview.previewCount(listOf(item(1, 1, State.ARRIVED), item(2, 0, State.PREPARING))))
        assertTrue(UploadOverview.isComplete(listOf(item(1, 1, State.ARRIVED), item(2, 0, State.CANCELLED))))
        assertFalse(UploadOverview.isComplete(listOf(item(1, 1, State.ARRIVED), item(2, 0, State.FINISHING))))
        assertFalse(UploadOverview.isComplete(listOf(item(2, 0, State.CANCELLED))))
    }

    @Test
    fun `queue states map onto upload items`() {
        assertEquals(State.PREPARING, UploadItem.stateOf(UploadState.HASHING))
        assertEquals(State.TRANSFERRING, UploadItem.stateOf(UploadState.UPLOADING))
        assertEquals(State.FINISHING, UploadItem.stateOf(UploadState.AWAITING_RECEIPT))
        assertEquals(State.ARRIVED, UploadItem.stateOf(UploadState.DEDUPLICATED))
        assertEquals(State.FAILED, UploadItem.stateOf(UploadState.FAILED))
    }

    @Test
    fun `local copies may go only after the server verified or matched the original`() {
        for (s in UploadState.entries) assertEquals(s.name, s == UploadState.VERIFIED || s == UploadState.DEDUPLICATED, LocalCopyPolicy.mayDelete(s))
        val rows = listOf("v" to UploadState.VERIFIED, "d" to UploadState.DEDUPLICATED, "a" to UploadState.AWAITING_RECEIPT, "f" to UploadState.FAILED, "h" to UploadState.VERIFIED)
        val choice = LocalCopyPolicy.receiptChoice(rows, state = { it.second }, hasLocalCopy = { it.first != "h" })
        assertEquals(listOf("v", "d"), choice.deletable.map { it.first })
        assertEquals(listOf("a"), choice.awaitingVerification.map { it.first })
    }
}
