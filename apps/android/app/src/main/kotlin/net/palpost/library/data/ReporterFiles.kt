package net.palpost.library.data

import java.io.File
import java.io.IOException
import net.palpost.library.core.send.ReporterMemory
import net.palpost.library.core.send.SendBatch
import net.palpost.library.core.send.SendBatchCodec
import net.palpost.library.core.send.SendBatchRead
import net.palpost.library.core.send.SendBatchStore
import net.palpost.library.core.upload.LocalAccounts

/**
 * Small JSON files in the app's no-backup folder (excluded from backups and device transfer; the emergency wipe's
 * `caches_and_files` step erases the folder). Written atomically: a temp file, then a rename. Nothing here is logged.
 */
private fun File.writeAtomically(text: String): Boolean = try {
    parentFile?.mkdirs()
    val tmp = File(parentFile, "$name.tmp")
    tmp.writeText(text, Charsets.UTF_8)
    if (!tmp.renameTo(this)) { delete(); tmp.renameTo(this) } else true
} catch (e: IOException) {
    false
}

/** What the app remembers for the reporter (`ReporterMemory`): the last place, the display name and earlier tags. Never coordinates. */
class ReporterMemoryStore(private val file: File) {
    private val lock = Any()

    fun load(): ReporterMemory = synchronized(lock) {
        if (!file.exists()) ReporterMemory() else runCatching { ReporterMemory.fromJson(file.readText(Charsets.UTF_8)) }.getOrDefault(ReporterMemory())
    }

    fun update(change: (ReporterMemory) -> ReporterMemory): ReporterMemory = synchronized(lock) {
        val next = change(load())
        file.writeAtomically(next.toJson())
        next
    }

    /** Sign-out, revocation and the emergency wipe: no place or tags of the previous reporter stay on the phone. */
    fun clear() = synchronized(lock) { file.delete(); Unit }
}

/** The sends file (`send-batches.json`, ADR 0088): «no file» is an empty list, a failed read is «unreadable», garbage is «corrupt». */
class FileSendBatchStore(private val file: File) : SendBatchStore {
    override fun read(): SendBatchRead {
        if (!file.exists()) return SendBatchRead.Batches(emptyList())
        val text = try { file.readText(Charsets.UTF_8) } catch (e: IOException) { return SendBatchRead.Unreadable }
        return SendBatchCodec.decode(text)?.let { SendBatchRead.Batches(it) } ?: SendBatchRead.Corrupt
    }

    override fun write(batches: List<SendBatch>): Boolean = file.writeAtomically(SendBatchCodec.encode(batches))

    override fun clear() { file.delete() }
}

/**
 * The accounts that signed in on this phone (`LocalAccounts`, ADR 0093), in the app's no-backup folder without a `.json`
 * extension. The emergency wipe erases it with the queue; sign-out keeps it. A file that exists and cannot be read gives null,
 * so a fresh record is never written over it.
 */
class LocalAccountsStore(private val file: File) {
    private val lock = Any()

    fun load(): LocalAccounts? = synchronized(lock) {
        if (!file.exists()) return LocalAccounts()
        val text = try { file.readText(Charsets.UTF_8) } catch (e: IOException) { return null }
        LocalAccounts.fromJson(text)
    }

    fun save(accounts: LocalAccounts): Boolean = synchronized(lock) { file.writeAtomically(accounts.toJson()) }

    /** The emergency wipe. */
    fun delete() = synchronized(lock) { file.delete(); Unit }
}
