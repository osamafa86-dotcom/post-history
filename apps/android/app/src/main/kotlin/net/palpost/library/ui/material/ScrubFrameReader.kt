package net.palpost.library.ui.material

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import net.palpost.library.core.materials.ScrubFrames
import net.palpost.library.core.materials.SignedUrlLease
import net.palpost.library.core.materials.SignedUrlRefresh
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reads frames of the verified light copy for the seek bar's bubble (ADR 0106). The link is asked for when the first frame is
 * wanted, renewed before it lapses, and kept in memory only; the platform's `MediaMetadataRetriever` reads through it on one
 * thread of its own, at the key frame nearest the moment, scaled down to fit [maxPx]. Nothing is written to disk (no cache of
 * any kind), and neither the link nor anything about the material is logged. The original is never read: the caller passes the
 * light copy's file id alone ([net.palpost.library.core.materials.ScrubPreviewPolicy]).
 */
class ScrubFrameReader(private val lease: suspend () -> SignedUrlLease?, private val maxPx: Int) : AutoCloseable {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "scrub-frames").apply { isDaemon = true } }
    private val thread = executor.asCoroutineDispatcher()
    private val closed = AtomicBoolean(false)

    // Touched on [thread] only.
    private var retriever: MediaMetadataRetriever? = null
    @Volatile private var current: SignedUrlLease? = null

    suspend fun frameAt(atMs: Long): ImageBitmap? {
        if (closed.get()) return null
        if (SignedUrlRefresh.beforePlayback(current, System.currentTimeMillis()) == SignedUrlRefresh.Decision.FETCH_NEW) {
            val fresh = lease() ?: return null
            withContext(thread) { open(fresh) }
            current = fresh
        }
        return withContext(thread) {
            val r = retriever?.takeUnless { closed.get() } ?: return@withContext null
            val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val params = MediaMetadataRetriever.BitmapParams().apply { preferredConfig = Bitmap.Config.RGB_565 }
                r.getScaledFrameAtTime(atMs * 1_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxPx, maxPx, params)
            } else {
                r.getScaledFrameAtTime(atMs * 1_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxPx, maxPx)
            }
            bitmap?.asImageBitmap()
        }
    }

    private fun open(link: SignedUrlLease) {
        retriever?.release()
        retriever = null
        if (closed.get()) return
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(link.url, emptyMap())
        } catch (e: RuntimeException) {
            r.release()
            throw e
        }
        retriever = r
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        current = null
        executor.execute { retriever?.release(); retriever = null }
        executor.shutdown()
    }
}

/**
 * The bubble's frames for one player and one light copy: the reader and what it read, closed together when the player leaves the
 * screen and first thing on a wipe, a revocation or sign-out ([PlaybackCenter.stopAll]).
 */
class ScrubSession(scope: CoroutineScope, lease: suspend () -> SignedUrlLease?, maxPx: Int) : AutoCloseable {
    private val reader = ScrubFrameReader(lease, maxPx)
    val frames = ScrubFrames<ImageBitmap>(scope, capacity = 24) { reader.frameAt(it) }

    override fun close() {
        frames.close()
        reader.close()
    }
}
