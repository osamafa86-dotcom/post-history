package net.palpost.library.core.send

import net.palpost.library.core.upload.UploadState

/** A file on the upload screen as the app maps it from a queue row (05 in reporter-v2.md): size, what arrived and the state; no path, no name. */
data class UploadItem(
    val id: String,
    val materialId: String,
    val sizeBytes: Long,
    val confirmedBytes: Long,
    val state: State,
    val paused: Boolean = false,
    /** The light copy of this material arrived and was verified: editors can watch it. */
    val previewArrived: Boolean = false,
) {
    enum class State {
        /** Hashing, creating the session, or waiting for the light copy. */
        PREPARING,
        TRANSFERRING,
        /** The bytes arrived; the server's check and receipt are pending. */
        FINISHING,
        /** The server verified the original (a receipt, or a match with an earlier verified original). */
        ARRIVED,
        FAILED,
        CANCELLED,
    }

    val isActive: Boolean get() = state == State.PREPARING || state == State.TRANSFERRING || state == State.FINISHING

    companion object {
        fun stateOf(s: UploadState): State = when (s) {
            UploadState.QUEUED, UploadState.HASHING, UploadState.CREATING_SESSION -> State.PREPARING
            UploadState.UPLOADING -> State.TRANSFERRING
            UploadState.AWAITING_RECEIPT -> State.FINISHING
            UploadState.VERIFIED, UploadState.DEDUPLICATED -> State.ARRIVED
            UploadState.FAILED -> State.FAILED
        }
    }
}

/**
 * The file's three stages (the plan: «preview arrived» · «original arrived and verified» · «backup complete»). The contract does
 * not carry the third (no field for the second provider's copy in `MaterialFile`), so no file reaches it here and it is not
 * claimed (ADR 0088).
 */
enum class UploadStage { NONE, PREVIEW, ORIGINAL, BACKUP }

/** What the broadcast rings and the upload rows show, as on iOS (`UploadOverview`). */
object UploadOverview {
    /** Pulsing while uploading, calm while waiting for the network, full on arrival, red on a failure that needs the reporter. */
    enum class RingState { UPLOADING, WAITING, DONE, FAILED }

    fun stage(item: UploadItem): UploadStage = when {
        item.state == UploadItem.State.ARRIVED -> UploadStage.ORIGINAL
        item.previewArrived -> UploadStage.PREVIEW
        else -> UploadStage.NONE
    }

    /** Share of what arrived, weighted by size; arrived counts whole, cancelled is left out. No files: 0. */
    fun fraction(items: List<UploadItem>): Double {
        val counted = items.filter { it.state != UploadItem.State.CANCELLED }
        val total = counted.sumOf { it.sizeBytes.coerceAtLeast(0) }
        if (total <= 0) return if (counted.isNotEmpty() && counted.all { it.state == UploadItem.State.ARRIVED }) 1.0 else 0.0
        val done = counted.sumOf { item ->
            val size = item.sizeBytes.coerceAtLeast(0)
            if (item.state == UploadItem.State.ARRIVED) size else item.confirmedBytes.coerceIn(0, size)
        }
        return minOf(1.0, done.toDouble() / total)
    }

    /** [online]: the network is usable under the upload policy (Wi-Fi only when that is on). */
    fun ringState(items: List<UploadItem>, online: Boolean): RingState {
        val counted = items.filter { it.state != UploadItem.State.CANCELLED }
        if (counted.any { it.state == UploadItem.State.FAILED }) return RingState.FAILED
        val active = counted.filter { it.isActive }
        if (active.isEmpty()) return if (counted.isEmpty()) RingState.WAITING else RingState.DONE
        if (!online || active.all { it.paused }) return RingState.WAITING
        return RingState.UPLOADING
    }

    /** How many files have their preview (light copy or original). */
    fun previewCount(items: List<UploadItem>): Int = items.count { stage(it) >= UploadStage.PREVIEW }

    /** The receipt shows when everything left of the send has arrived: every file not cancelled arrived, and at least one. */
    fun isComplete(items: List<UploadItem>): Boolean {
        val counted = items.filter { it.state != UploadItem.State.CANCELLED }
        return counted.isNotEmpty() && counted.all { it.state == UploadItem.State.ARRIVED }
    }
}

/**
 * When the original may be deleted from the phone (the plan: after «the original arrived and was verified»; ADR 0088): one rule
 * every deletion choice goes through (the send's receipt, a single material's receipt, «Show receipt» in My materials).
 * Allowed: the server verified the digest and issued a receipt, or matched an earlier verified original. Nothing else: bytes
 * that arrived without the digest check may still fail, and a failed upload has no verified original; the phone's file is the
 * only one an upload can be repeated from. On Android the «local copy» is the picked file itself in the phone's gallery (the
 * app keeps no copy, ADR 0082), deleted through the system's confirmation.
 */
object LocalCopyPolicy {
    fun mayDelete(state: UploadState): Boolean = state == UploadState.VERIFIED || state == UploadState.DEDUPLICATED

    /** [deletable] are offered deletion; [awaitingVerification] are on their way, so the receipt says deletion comes after. */
    data class ReceiptChoice<T>(val deletable: List<T>, val awaitingVerification: List<T>)

    /** [hasLocalCopy]: the file is still on the phone and the reporter has not decided about it. Failed rows enter neither list. */
    fun <T> receiptChoice(scope: List<T>, state: (T) -> UploadState, hasLocalCopy: (T) -> Boolean): ReceiptChoice<T> {
        val withCopy = scope.filter(hasLocalCopy)
        return ReceiptChoice(withCopy.filter { mayDelete(state(it)) }, withCopy.filter { !state(it).terminal })
    }
}
