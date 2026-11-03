package net.palpost.library.core.notifications

/**
 * One id space for every notification the app posts, in ranges that never meet: a push about a material must not replace an upload's
 * receipt, nor a receipt a push, as the overlapping ranges before did (push 3000–7095 inside receipts 2000–67535). Each range is
 * 65,536 wide; within one, two keys may still share an id (a hash), which only makes the newer replace the older of the same kind.
 */
object NotificationIds {
    /** The transfer's ongoing notification (foreground service or user-initiated job). */
    const val UPLOAD_PROGRESS = 1001

    val UPLOAD_RESULTS: IntRange = 0x10000 until 0x20000
    val PUSH: IntRange = 0x20000 until 0x30000

    /** An upload's receipt or failure, one per queue row. */
    fun uploadResult(taskId: String): Int = UPLOAD_RESULTS.first + (taskId.hashCode() and 0xFFFF)

    /** A push notification, one per server notification id. */
    fun push(notificationId: String?): Int = PUSH.first + ((notificationId?.hashCode() ?: 0) and 0xFFFF)
}
