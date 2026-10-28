package net.palpost.library.upload

import android.content.Context
import android.content.Intent
import android.net.Uri
import net.palpost.library.data.UploadDatabase

/**
 * Persisted read grants on the originals the reporter picked are limited per app by the system, and one is taken per file,
 * so they are released as soon as nothing in the app needs the file: a removed row, a discarded input, a finished receipt.
 */
object UriGrants {
    /**
     * Releases the grant on [uri] unless a queue row (other than [exceptTaskId]) or a saved draft still points at it:
     * those still need to read, or to offer to delete, the file.
     */
    suspend fun releaseIfUnused(context: Context, db: UploadDatabase, uri: String, exceptTaskId: String = "") {
        if (db.uploads().countByUri(uri, exceptTaskId) > 0 || db.drafts().countMentioning(uri) > 0) return
        try {
            context.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) {
            // No grant was held for this URI (a temporary picker grant, or already released): nothing to do.
        }
    }
}
