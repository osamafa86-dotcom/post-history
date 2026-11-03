package net.palpost.library.core.notifications

import net.palpost.library.core.materials.LocalRecord
import net.palpost.library.core.upload.AccountScope
import net.palpost.library.core.upload.UploadState
import java.security.MessageDigest

// Where a tap on a notification leads (ADR 0106, the follow-up ADR 0095 left): the material, or the receipt of its original on
// this phone, by ids alone. Pure logic, tested on the JVM.

/** The screen a notification opens. */
sealed interface NotificationTarget {
    /** The notifications list, as before: a notification with no material of the reporter's own. */
    data object Inbox : NotificationTarget

    /** The material's detail (08). */
    data class Material(val materialId: String) : NotificationTarget

    /** The receipt of the material's original on this phone (06); its detail when the phone has no such row. */
    data class Receipt(val materialId: String) : NotificationTarget
}

/**
 * A tap waiting to be followed: its target, and the opaque local id of the account that was signed in when the notification
 * showed ([AccountScope], never the email or the server id), so it is followed for that account alone.
 */
data class NotificationLink(val target: NotificationTarget, val account: String?)

object NotificationLinks {
    const val EXTRA_OPEN = "open"
    const val EXTRA_MATERIAL = "material"
    const val EXTRA_ACCOUNT = "account"
    const val EXTRA_KEY = "key"

    /** The value earlier releases put on every notification; still understood for those already on the screen. */
    const val OPEN_INBOX = "notifications"
    const val OPEN_MATERIAL = "material"
    const val OPEN_RECEIPT = "receipt"

    /** The original's receipt (`upload.verified`, and a file the server already had). */
    val RECEIPT_EVENTS = setOf("upload.verified", "upload.deduplicated")

    /**
     * The reporter's own news about a material (the server's reporter notifications, `notifications/fanout.ts`). Anything else
     * with a material (a supervisor's or a producer's, an escalation) opens the list: «My materials» is not their screen.
     */
    val MATERIAL_EVENTS = setOf("material.acknowledged", "material.change_requested", "material.published")

    private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** A material id in its canonical form, or null: nothing else is ever carried or opened. */
    fun materialId(raw: String?): String? = raw?.takeIf { UUID_PATTERN.matches(it) }?.lowercase()

    /** From the notification's event type and material id alone (the push payload or the in-app `Notification`). */
    fun targetOf(type: String?, materialId: String?): NotificationTarget {
        val id = materialId(materialId) ?: return NotificationTarget.Inbox
        return when (type) {
            in RECEIPT_EVENTS -> NotificationTarget.Receipt(id)
            in MATERIAL_EVENTS -> NotificationTarget.Material(id)
            else -> NotificationTarget.Inbox
        }
    }

    /**
     * The extras of the tap's intent: the target's kind and id, the account's local id, and this installation's link key, which
     * nothing outside the app knows, so another app cannot make this one open a screen by sending it an intent.
     */
    fun extras(link: NotificationLink, key: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        when (val t = link.target) {
            NotificationTarget.Inbox -> out[EXTRA_OPEN] = OPEN_INBOX
            is NotificationTarget.Material -> { out[EXTRA_OPEN] = OPEN_MATERIAL; out[EXTRA_MATERIAL] = t.materialId }
            is NotificationTarget.Receipt -> { out[EXTRA_OPEN] = OPEN_RECEIPT; out[EXTRA_MATERIAL] = t.materialId }
        }
        link.account?.let { out[EXTRA_ACCOUNT] = it }
        out[EXTRA_KEY] = key
        return out
    }

    /**
     * The tap read back from an intent; null when it is none. The list opens without the key (as it did, and it shows nothing
     * the reporter cannot open from home); a material or a receipt only with this installation's key and a well-formed id.
     */
    fun parse(extra: (String) -> String?, key: String?): NotificationLink? {
        val open = extra(EXTRA_OPEN) ?: return null
        val account = extra(EXTRA_ACCOUNT)?.takeIf { it.isNotBlank() && it.length <= 64 }
        if (open == OPEN_INBOX) return NotificationLink(NotificationTarget.Inbox, account)
        if (open != OPEN_MATERIAL && open != OPEN_RECEIPT) return null
        if (!sameKey(extra(EXTRA_KEY), key)) return null
        val id = materialId(extra(EXTRA_MATERIAL)) ?: return null
        val target = if (open == OPEN_MATERIAL) NotificationTarget.Material(id) else NotificationTarget.Receipt(id)
        return NotificationLink(target, account)
    }

    private fun sameKey(given: String?, key: String?): Boolean {
        if (given.isNullOrEmpty() || key.isNullOrEmpty()) return false
        return MessageDigest.isEqual(given.toByteArray(Charsets.UTF_8), key.toByteArray(Charsets.UTF_8))
    }

    /** What to do with a waiting tap once somebody is signed in. */
    sealed interface Step {
        /** The signed-in account is not known yet (the scope follows the session a moment later): keep it. */
        data object Wait : Step

        /** Meant for another account on this shared phone: forget it, and stay home. */
        data object Drop : Step

        data class Open(val target: NotificationTarget) : Step
    }

    /**
     * After the sign-in (or at once when signed in): followed for the account it was shown to; for another account it is
     * dropped. A tap with no account (the accounts file could not be read when it showed) is followed, and the server's own
     * permissions decide what the material screen may show.
     */
    fun step(link: NotificationLink, scope: AccountScope): Step {
        val current = scope.current ?: return Step.Wait
        if (link.account != null && link.account != current) return Step.Drop
        return Step.Open(link.target)
    }

    /**
     * The row whose receipt a receipt notification opens: the signed-in account's own original of that material that the server
     * verified or matched, the newest; null when the phone has none (another phone sent it, or it was removed), and then the
     * material's detail opens. [records] are the signed-in account's rows only.
     */
    fun receiptRecord(materialId: String, records: List<LocalRecord>): LocalRecord? =
        records.filter { it.materialId.equals(materialId, ignoreCase = true) && it.kind == "original" && (it.state == UploadState.VERIFIED || it.state == UploadState.DEDUPLICATED) }
            .maxByOrNull { it.createdAtEpochMs }
}
