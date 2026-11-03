package net.palpost.library.ui.receipt

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import net.palpost.library.AppContainer
import net.palpost.library.core.materials.ReceiptInbox
import net.palpost.library.core.send.SendBatch
import net.palpost.library.core.send.SendBatchLedger
import net.palpost.library.core.send.UploadItem
import net.palpost.library.core.upload.UploadState
import net.palpost.library.data.UploadTaskEntity

/** What a receipt is for: one send (its files together), or one queue row outside any send (a replacement shot, or an earlier build's). */
sealed interface ReceiptTarget {
    data class Batch(val batchId: String) : ReceiptTarget
    data class Task(val taskId: String) : ReceiptTarget
}

/** The send's originals as the upload screen counts them: a material whose row was cancelled (removed) is left out. */
fun itemsOf(batch: SendBatch, rows: List<UploadTaskEntity>): List<UploadItem> = batch.materialIds.mapNotNull { m ->
    rows.filter { it.materialId == m && it.kind == "original" }.maxByOrNull { it.createdAtEpochMs }?.let { r ->
        UploadItem(r.id, r.materialId, r.sizeBytes, r.bytesConfirmed, UploadItem.stateOf(UploadState.valueOf(r.state)))
    }
}

/**
 * One receipt per send (ADR 0088), as on iOS: when an original is verified, the ledger decides between the send's receipt
 * (when everything left of it has arrived and its loop has closed) and the material's own. Receipts wait in a queue that the
 * screens show one at a time, never over the send screen while it closes. Memory only; a send whose receipt was not shown
 * (the app was closed while its last file arrived) is found again from the ledger at the next start.
 *
 * A receipt goes to its owner alone (ADR 0093): one for another account, or with nobody signed in, waits in the inbox until its
 * owner signs in; the receipts on screen or queued at sign-out go back to waiting.
 */
class ReceiptCenter(private val container: AppContainer) {
    private val _pending = MutableStateFlow<List<ReceiptTarget>>(emptyList())
    val pending: StateFlow<List<ReceiptTarget>> = _pending
    private var previous: Map<String, String>? = null
    @Volatile private var rows: List<UploadTaskEntity> = emptyList()

    private val ledger: SendBatchLedger get() = container.sendBatches
    private val inbox = ReceiptInbox<ReceiptTarget>()
    @Volatile private var onScreen: ReceiptTarget? = null

    private fun ownerOf(t: ReceiptTarget): String? = when (t) {
        is ReceiptTarget.Batch -> ledger.batches.firstOrNull { it.id == t.batchId }?.owner
        is ReceiptTarget.Task -> rows.firstOrNull { it.id == t.taskId }?.ownerAccount
    }

    /** Follows the queue while the app is open (call from a coroutine tied to the signed-in screen). */
    suspend fun run() {
        previous = null
        container.database.uploads().observeAll().collect { list -> onRows(list) }
    }

    internal fun onRows(list: List<UploadTaskEntity>) {
        rows = list
        val before = previous
        previous = list.associate { it.id to it.state }
        if (before == null) {
            // Start: the sends whose last file arrived while no screen was open.
            ledger.refresh()
            for (b in ledger.batches.reversed()) ledger.receiptDueForBatch(b.id) { itemsOf(it, list) }?.let { enqueue(it) }
            return
        }
        for (t in list.sortedBy { it.createdAtEpochMs }) {
            val was = before[t.id]
            if (was == null || was == t.state || t.state !in DONE || t.kind != "original") continue
            when (val scope = ledger.receiptDueForMaterial(t.materialId) { itemsOf(it, list) }) {
                is SendBatchLedger.ReceiptScope.Material -> enqueue(ReceiptTarget.Task(t.id))
                is SendBatchLedger.ReceiptScope.Batch -> enqueue(ReceiptTarget.Batch(scope.batchId))
                null -> Unit
            }
        }
    }

    /** After a send loop closes: its files may all have arrived during the loop, and no later event would bring the receipt. */
    fun afterSend(batchId: String) {
        val list = rows
        (ledger.receiptDueForBatch(batchId) { itemsOf(it, list) } as? SendBatchLedger.ReceiptScope.Batch)?.let { enqueue(ReceiptTarget.Batch(it.batchId)) }
    }

    private fun enqueue(scope: SendBatchLedger.ReceiptScope) {
        when (scope) {
            is SendBatchLedger.ReceiptScope.Batch -> enqueue(ReceiptTarget.Batch(scope.batchId))
            is SendBatchLedger.ReceiptScope.Material -> Unit
        }
    }

    private fun enqueue(target: ReceiptTarget) {
        val now = inbox.arrive(target, ownerOf(target), container.scope.value) ?: return
        _pending.update { if (now in it) it else it + now }
    }

    /** The receipt is on screen: a send's receipt is marked shown so it never comes twice. */
    fun shown(target: ReceiptTarget) {
        _pending.update { it - target }
        onScreen = target
        if (target is ReceiptTarget.Batch) ledger.markReceiptShown(target.batchId)
    }

    /** The receipt on screen was closed. */
    fun closed() { onScreen = null }

    /** A sign-in: the receipts that waited for this account, oldest first. */
    fun signedIn() {
        val scope = container.scope.value
        while (true) {
            val next = inbox.next(scope) ?: break
            _pending.update { if (next in it) it else it + next }
        }
    }

    /**
     * Sign-out, before the sends file is erased: the receipt on screen and the queued ones wait for their owner. A send's receipt
     * waits as the receipt of its last arrived original, since its send will not be on the phone when the owner comes back.
     */
    fun signedOut() {
        val list = rows
        for (t in listOfNotNull(onScreen) + _pending.value) {
            val owner = ownerOf(t)
            val held = when (t) {
                is ReceiptTarget.Task -> t
                is ReceiptTarget.Batch -> ledger.batches.firstOrNull { it.id == t.batchId }
                    ?.let { b -> itemsOf(b, list).lastOrNull { it.state == UploadItem.State.ARRIVED } }?.let { ReceiptTarget.Task(it.id) }
            }
            held?.let { inbox.hold(it, owner) }
        }
        _pending.value = emptyList()
        onScreen = null
        previous = null
    }

    /** The emergency wipe and revocation: nothing waits for anyone. */
    fun clear() {
        _pending.value = emptyList()
        onScreen = null
        inbox.removeAll()
        previous = null
    }

    companion object {
        val DONE = setOf(UploadState.VERIFIED.name, UploadState.DEDUPLICATED.name)
    }
}
