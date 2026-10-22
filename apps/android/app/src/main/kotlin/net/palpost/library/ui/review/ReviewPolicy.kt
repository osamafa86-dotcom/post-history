package net.palpost.library.ui.review

import net.palpost.library.api.models.EditorialState
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.Priority
import net.palpost.library.core.net.ApiFailure

/**
 * The supervisor's editorial decisions, exactly the supervisor rows of the contract's transition table
 * (`POST /materials/{id}/transitions`). Only the editorial track: the technical track belongs to the server and
 * the rights track to the rights officer, so the three states stay independent here too. The server remains the
 * judge; this only decides which buttons to offer.
 */
enum class ReviewAction(val to: EditorialState) {
    ACKNOWLEDGE(EditorialState.acknowledged),
    START_REVIEW(EditorialState.reviewing),
    REQUEST_CHANGES(EditorialState.needs_changes),
    ACCEPT(EditorialState.accepted),
    REJECT(EditorialState.rejected),
}

object ReviewPolicy {
    /** The editorial states a supervisor works from; the inbox filters offer these, in this order. */
    val QUEUE = listOf(EditorialState.inbox, EditorialState.acknowledged, EditorialState.reviewing)

    const val REASON_MAX = 2000

    fun actionsFor(state: EditorialState): List<ReviewAction> = when (state) {
        EditorialState.inbox -> listOf(ReviewAction.ACKNOWLEDGE, ReviewAction.REJECT)
        EditorialState.acknowledged -> listOf(ReviewAction.START_REVIEW, ReviewAction.REJECT)
        EditorialState.reviewing -> listOf(ReviewAction.ACCEPT, ReviewAction.REQUEST_CHANGES, ReviewAction.REJECT)
        else -> emptyList()
    }

    /** The reason the contract requires (1–2000 characters), trimmed; null when there is none to send. */
    fun reason(text: String): String? = text.trim().takeIf { it.isNotEmpty() && it.length <= REASON_MAX }

    /** `If-Match` from the row version the supervisor saw, so a decision on a stale view is refused without effect. */
    fun ifMatch(m: Material): String? = m.rowVersion?.let { "\"$it\"" }

    /** Urgent first, otherwise the server's order (newest first); stable, so paging does not reshuffle the rest. */
    fun ordered(items: List<Material>): List<Material> = items.sortedBy { if (it.priority == Priority.urgent) 0 else 1 }

    enum class Outcome { DONE, STALE, FORBIDDEN, RETRY, FAILED }

    /**
     * What a failed decision means for the screen. A stale view (`412`) or a transition someone else already made
     * (`409`) reloads the material and drops the decision; a network failure keeps it to retry under the same
     * idempotency key.
     */
    fun outcomeOf(t: Throwable?): Outcome {
        if (t == null) return Outcome.DONE
        val f = ApiFailure.from(t) ?: return Outcome.RETRY
        return when {
            f.status == 412 || f.status == 409 -> Outcome.STALE
            f.status == 403 -> Outcome.FORBIDDEN
            f.status >= 500 || f.status == 429 -> Outcome.RETRY
            else -> Outcome.FAILED
        }
    }
}
