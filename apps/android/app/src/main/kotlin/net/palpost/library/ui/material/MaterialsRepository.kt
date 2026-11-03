package net.palpost.library.ui.material

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import android.util.Size
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import net.palpost.library.api.apis.MaterialsApi
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialPage
import net.palpost.library.core.materials.MaterialsFeed
import net.palpost.library.core.materials.MaterialsListApi
import net.palpost.library.core.materials.MaterialsListState
import net.palpost.library.core.materials.PageProgress
import net.palpost.library.core.materials.SignedUrlLease
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException

/** What My materials shows, as one value the screens collect. */
data class MaterialsSnapshot(val items: List<Material> = emptyList(), val pages: PageProgress = PageProgress(), val lastUpdatedEpochMs: Long? = null, val loading: Boolean = false)

/**
 * My materials for the whole app (ADR 0089): one feed whose loads run one at a time, and the list state with its generation, so
 * the emergency wipe, sign-out and revocation ([clear]) drop every result that started before them, whichever screen asked.
 */
class MaterialsRepository(private val api: () -> MaterialsApi) {
    val feed = MaterialsFeed(object : MaterialsListApi {
        override suspend fun page(cursor: String?, limit: Int): MaterialPage = api().listMaterials(cursor = cursor, limit = limit.toLong())
        override suspend fun material(id: UUID): Material = api().getMaterial(id)
    })
    private val list = MaterialsListState()
    private val _state = MutableStateFlow(MaterialsSnapshot())
    val state: StateFlow<MaterialsSnapshot> = _state
    private val inFlight = AtomicInteger()
    /** A «next page» is asked for and not yet back: the end row does not ask again. */
    @Volatile var nextPagePending = false; private set

    private fun publish() = synchronized(list) {
        _state.value = MaterialsSnapshot(list.items, list.pages, list.lastUpdatedEpochMs, inFlight.get() > 0)
    }

    private suspend fun load(firstPage: Boolean, op: suspend () -> List<Material>) {
        val ticket = synchronized(list) { list.ticket() }
        inFlight.incrementAndGet(); publish()
        val result = try { Result.success(op()) } catch (t: Throwable) { Result.failure(t) }
        inFlight.decrementAndGet()
        synchronized(list) { list.settle(ticket, result, feed.progress, if (firstPage && result.isSuccess) System.currentTimeMillis() else null) }
        publish()
        result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
    }

    suspend fun refresh() = load(firstPage = true) { feed.refresh() }

    /** The poll and coming back: merges the first page, unless the last good update is fresher than [minAgeMs]. */
    suspend fun refreshHead(minAgeMs: Long = 0) {
        val last = _state.value.lastUpdatedEpochMs
        if (minAgeMs > 0 && last != null && System.currentTimeMillis() - last < minAgeMs) return
        load(firstPage = true) { feed.refreshHead() }
    }

    suspend fun loadMore() {
        nextPagePending = true
        try { load(firstPage = false) { feed.loadMore() } } finally { nextPagePending = false; publish() }
    }

    suspend fun reload(id: UUID): Material? {
        val ticket = synchronized(list) { list.ticket() }
        val m = runCatching { feed.reload(id) }.getOrElse { if (it is CancellationException) throw it; return null }
        synchronized(list) { list.replaceItems(ticket, feed.items) }
        publish()
        return m
    }

    /** The emergency wipe, sign-out and revocation: nothing of the previous reporter stays, and loads in flight fall. */
    fun clear() {
        feed.clear()
        synchronized(list) { list.clear() }
        publish()
    }
}

/**
 * Thumbnails in memory only (160 entries; nothing on disk), with a generation so a load that started before a wipe never
 * writes after it. A remote picture is refused before it starts when it declares more than 12 MB, and cut the moment it passes.
 */
class ThumbnailCache(private val http: OkHttpClient) {
    private val cache = LruCache<String, ImageBitmap>(160)
    private val generation = AtomicInteger()

    fun get(key: String): ImageBitmap? = cache.get(key)

    /** The system's thumbnail of a picked file, read without copying it; [px] small (48) when it will show blurred. */
    suspend fun local(context: Context, uri: String, px: Int): ImageBitmap? {
        val key = "l:$px:$uri"
        cache.get(key)?.let { return it }
        val gen = generation.get()
        val bmp = withContext(Dispatchers.IO) {
            runCatching { context.contentResolver.loadThumbnail(Uri.parse(uri), Size(px, px), null).asImageBitmap() }.getOrNull()
        } ?: return null
        if (gen == generation.get()) cache.put(key, bmp)
        return bmp
    }

    /** A verified derivative through its signed link (asked for now, used once, never kept). */
    suspend fun remote(fileId: String, px: Int, lease: suspend () -> SignedUrlLease?): ImageBitmap? {
        val key = "r:$px:$fileId"
        cache.get(key)?.let { return it }
        val gen = generation.get()
        val url = lease()?.url ?: return null
        val bytes = withContext(Dispatchers.IO) { runCatching { download(url) }.getOrNull() } ?: return null
        val bmp = withContext(Dispatchers.Default) { decode(bytes, px) } ?: return null
        if (gen == generation.get()) cache.put(key, bmp)
        return bmp
    }

    private fun download(url: String): ByteArray? {
        http.newCall(Request.Builder().url(url).header("Cache-Control", "no-store").build()).execute().use { r ->
            if (!r.isSuccessful) return null
            val body = r.body ?: return null
            if (body.contentLength() > MAX_BYTES) return null
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            body.byteStream().use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > MAX_BYTES) throw IOException("too large")
                    out.write(buf, 0, n)
                }
            }
            return out.toByteArray()
        }
    }

    private fun decode(bytes: ByteArray, px: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= px && bounds.outHeight / (sample * 2) >= px) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }

    fun clear() {
        generation.incrementAndGet()
        cache.evictAll()
    }

    companion object {
        const val MAX_BYTES = 12L * 1024 * 1024
    }
}
