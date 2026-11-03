package net.palpost.library.core.materials

import net.palpost.library.api.models.MaterialFile.Kind
import net.palpost.library.api.models.MaterialFile.ProxyMode
import net.palpost.library.api.models.MaterialFile.State
import net.palpost.library.core.materials.Fixtures.file
import net.palpost.library.core.materials.Fixtures.material
import net.palpost.library.core.upload.UploadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackTest {
    private val sha = "a".repeat(64)
    private val other = "b".repeat(64)

    private fun row(id: String, state: UploadState, sha: String? = null, at: Long = 1, m: Int = 1) =
        LocalRecord(id, Fixtures.id(m).toString(), "original", sha, state, at, "video/mp4", "content://x/$id")

    private val everyCopy: (LocalRecord) -> Boolean = { true }

    @Test
    fun `with a verified digest on the server only the matching row is the phone original`() {
        val m = material(1, files = listOf(file(1, Kind.original, sha = sha.uppercase())))
        val rows = listOf(row("match", UploadState.VERIFIED, sha, at = 1), row("other", UploadState.VERIFIED, other, at = 5), row("uploading", UploadState.UPLOADING, at = 9))
        assertEquals("match", LocalOriginals.find(m, rows, everyCopy)?.recordId)
        // A row with no digest kept is accepted when the server confirmed it; one with another digest never.
        assertEquals("nodigest", LocalOriginals.find(m, listOf(row("nodigest", UploadState.DEDUPLICATED), row("other", UploadState.VERIFIED, other)), everyCopy)?.recordId)
        assertNull(LocalOriginals.find(m, listOf(row("other", UploadState.VERIFIED, other), row("up", UploadState.UPLOADING)), everyCopy))
    }

    @Test
    fun `a verified original without a digest takes a row the server confirmed`() {
        val m = material(1, files = listOf(file(1, Kind.original)))
        assertEquals("ok", LocalOriginals.find(m, listOf(row("ok", UploadState.VERIFIED, at = 1), row("failed", UploadState.FAILED, at = 3)), everyCopy)?.recordId)
        assertNull(LocalOriginals.find(m, listOf(row("failed", UploadState.FAILED)), everyCopy))
    }

    @Test
    fun `before verification the newest row on its way, never a refused one`() {
        val m = material(1)
        assertEquals("b", LocalOriginals.find(m, listOf(row("a", UploadState.UPLOADING, at = 1), row("b", UploadState.QUEUED, at = 2), row("f", UploadState.FAILED, at = 3)), everyCopy)?.recordId)
        assertNull(LocalOriginals.find(m, listOf(row("f", UploadState.FAILED)), everyCopy))
    }

    @Test
    fun `the absence line says why`() {
        val m = material(1, files = listOf(file(1, Kind.original, sha = sha)))
        assertEquals(LocalOriginalAbsence.NOT_ON_PHONE, LocalOriginals.absence(m, emptyList(), everyCopy))
        assertEquals(LocalOriginalAbsence.REMOVED_FROM_PHONE, LocalOriginals.absence(m, listOf(row("a", UploadState.VERIFIED, sha)), { false }))
        assertEquals(LocalOriginalAbsence.NOT_THE_VERIFIED_ORIGINAL, LocalOriginals.absence(m, listOf(row("a", UploadState.VERIFIED, other)), everyCopy))
        assertNull(LocalOriginals.absence(m, listOf(row("a", UploadState.VERIFIED, sha)), everyCopy))
    }

    @Test
    fun `the player takes the phone first, then verified hls, then verified proxy, then processing`() {
        val local = LocalOriginal("r", "content://x/r", "video/mp4")
        val m = material(1, files = listOf(file(1, Kind.original), file(2, Kind.hls), file(3, Kind.proxy, proxyMode = ProxyMode.normal), file(4, Kind.hls, State.received)))
        assertEquals(PlaybackSource.Local(local), PlaybackSourcePolicy.player(m, local))
        val hls = PlaybackSourcePolicy.player(m, null) as PlaybackSource.Remote
        assertEquals(Kind.hls, hls.kind)
        assertEquals(Fixtures.id(1002).toString(), hls.fileId)
        assertEquals(PlaybackSource.Remote(Fixtures.id(1003).toString(), Kind.proxy, PlaybackQuality.LightCopy(540)), PlaybackSourcePolicy.fallback(hls, m))
        assertNull(PlaybackSourcePolicy.fallback(PlaybackSourcePolicy.fallback(hls, m)!!, m))
        val onlyProxy = material(2, files = listOf(file(5, Kind.proxy, proxyMode = ProxyMode.urgent)))
        assertEquals(PlaybackQuality.LightCopy(360), PlaybackSourcePolicy.player(onlyProxy, null).quality)
        // Only the original arrived (no media worker): processing, and never a link for the original.
        assertEquals(PlaybackSource.Unavailable, PlaybackSourcePolicy.player(material(3, files = listOf(file(6, Kind.original))), null))
        assertFalse(Kind.original in PlaybackSourcePolicy.linkableKinds)
    }

    @Test
    fun `sensitive pictures stay concealed until tapped, and no cloud thumbnail is asked for`() {
        val sensitive = material(1, sensitive = true, files = listOf(file(1, Kind.thumbnail), file(2, Kind.proxy, mime = "image/jpeg")))
        assertEquals(PreviewSource.Unavailable, PlaybackSourcePolicy.thumbnail(sensitive, null))
        val local = LocalOriginal("r", "content://x/r", "image/jpeg")
        assertEquals(PreviewSource.Local(local), PlaybackSourcePolicy.thumbnail(sensitive, local))
        assertTrue(PlaybackSourcePolicy.conceals(sensitive, revealed = false))
        assertFalse(PlaybackSourcePolicy.conceals(sensitive, revealed = true))
        assertEquals(PreviewSource.Unavailable, PlaybackSourcePolicy.still(sensitive, local, requested = false))
        assertEquals(PreviewSource.Remote(Fixtures.id(1002).toString()), PlaybackSourcePolicy.still(sensitive, null, requested = true))
        val plain = material(2, files = listOf(file(3, Kind.thumbnail)))
        assertEquals(PreviewSource.Remote(Fixtures.id(1003).toString()), PlaybackSourcePolicy.thumbnail(plain, null))
        assertTrue(PlaybackSourcePolicy.concealsUpload(null, null))
        assertFalse(PlaybackSourcePolicy.concealsUpload(null, false))
        assertTrue(PlaybackSourcePolicy.concealsUpload(sensitive, false))
        assertFalse(PlaybackSourcePolicy.concealsUpload(plain, true))
    }

    @Test
    fun `signed links are https only, kept fresh and never refreshed in a loop`() {
        assertNull(SignedUrlLease.of("http://h/x", 0))
        assertNull(SignedUrlLease.of("https:///nohost", 0))
        val lease = SignedUrlLease.of("https://h/x", 600_000)!!
        assertFalse(lease.toString().contains("https"))
        assertTrue(lease.isFresh(539_999))
        assertFalse(lease.isFresh(540_000))
        assertEquals(SignedUrlRefresh.Decision.USE_CURRENT, SignedUrlRefresh.beforePlayback(lease, 0))
        assertEquals(SignedUrlRefresh.Decision.FETCH_NEW, SignedUrlRefresh.beforePlayback(lease, 550_000))
        assertEquals(SignedUrlRefresh.Decision.FETCH_NEW, SignedUrlRefresh.beforePlayback(null, 0))
        assertEquals(SignedUrlRefresh.Decision.FETCH_NEW, SignedUrlRefresh.afterFailure(lease, 0, 0))
        assertEquals(SignedUrlRefresh.Decision.GIVE_UP, SignedUrlRefresh.afterFailure(lease, 0, 1))
        assertEquals(SignedUrlRefresh.Decision.FETCH_NEW, SignedUrlRefresh.afterFailure(lease, 590_000, 1))
        assertEquals(SignedUrlRefresh.Decision.GIVE_UP, SignedUrlRefresh.afterFailure(null, 0, 2))
    }
}
