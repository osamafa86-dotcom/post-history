package net.palpost.library.core.materials

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.api.models.MaterialFile.Kind
import net.palpost.library.core.materials.Fixtures.file
import net.palpost.library.core.materials.Fixtures.material
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ScrubPreviewTest {
    private val local = PlaybackSource.Local(LocalOriginal("row", "content://sample/1", "video/mp4"))
    private val hls = PlaybackSource.Remote("hls-id", Kind.hls, PlaybackQuality.Adaptive)

    @Test
    fun `frames come from the verified light copy alone, never the original or the poster`() {
        val proxy = file(1, Kind.proxy, mime = "video/mp4")
        val withProxy = material(1, files = listOf(file(2, Kind.original, mime = "video/mp4"), proxy, file(3, Kind.thumbnail, mime = "image/jpeg")))
        assertEquals(ScrubPreviewSource.LightCopy(proxy.id.toString()), ScrubPreviewPolicy.source(withProxy, local))
        assertEquals(ScrubPreviewSource.LightCopy(proxy.id.toString()), ScrubPreviewPolicy.source(withProxy, hls))
        // The original verified and the poster: the time alone.
        val noProxy = material(2, files = listOf(file(2, Kind.original, mime = "video/mp4"), file(3, Kind.thumbnail, mime = "image/jpeg")))
        assertEquals(ScrubPreviewSource.TimeOnly, ScrubPreviewPolicy.source(noProxy, local))
        // A light copy not verified yet, or a picture (a photo's light copy), gives no frames.
        assertEquals(ScrubPreviewSource.TimeOnly, ScrubPreviewPolicy.source(material(3, files = listOf(file(1, Kind.proxy, state = MaterialFile.State.received))), local))
        assertEquals(ScrubPreviewSource.TimeOnly, ScrubPreviewPolicy.source(material(4, files = listOf(file(1, Kind.proxy, mime = "image/jpeg"))), local))
        // Nothing to play, nothing to preview.
        assertEquals(ScrubPreviewSource.TimeOnly, ScrubPreviewPolicy.source(withProxy, PlaybackSource.Unavailable))
    }

    @Test
    fun `the newest verified light copy is the one read`() {
        val older = file(1, Kind.proxy, mime = "video/mp4", at = Fixtures.t0)
        val newer = file(2, Kind.proxy, at = Fixtures.t0.plusMinutes(5))
        val m = material(1, files = listOf(older, newer))
        assertEquals(ScrubPreviewSource.LightCopy(newer.id.toString()), ScrubPreviewPolicy.source(m, local))
    }

    @Test
    fun `a sensitive material asks the server for frames only when it already plays from the server`() {
        val proxy = file(1, Kind.proxy, mime = "video/mp4")
        val m = material(1, sensitive = true, files = listOf(proxy))
        assertEquals(ScrubPreviewSource.TimeOnly, ScrubPreviewPolicy.source(m, local))
        assertEquals(ScrubPreviewSource.LightCopy(proxy.id.toString()), ScrubPreviewPolicy.source(m, hls))
    }

    @Test
    fun `moments are rounded down to a step of a second or a hundredth of the video, within it`() {
        assertEquals(12_000L, ScrubPreviewPolicy.bucket(12_345, 60_000))
        assertEquals(60_000L, ScrubPreviewPolicy.bucket(70_000, 60_000))
        assertEquals(0L, ScrubPreviewPolicy.bucket(-5, 60_000))
        // An hour: a step of 36 s, so a drag never asks for more than a hundred frames.
        assertEquals(72_000L, ScrubPreviewPolicy.bucket(100_000, 3_600_000))
        assertEquals(101, (0L..3_600_000L step 500).map { ScrubPreviewPolicy.bucket(it, 3_600_000) }.toSet().size)
        // An unknown length: a step of a second.
        assertEquals(4_000L, ScrubPreviewPolicy.bucket(4_999, 0))
    }

    @Test
    fun `the bubble sits over the thumb, inside the window, above the bar`() {
        val mid = ScrubBubblePlacement.place(anchorLeft = 100, anchorTop = 500, anchorWidth = 400, insetPx = 20, fraction = 0.5f, bubbleWidth = 100, bubbleHeight = 80, windowWidth = 600, gapPx = 8)
        assertEquals(ScrubBubblePlacement.Offset(250, 412), mid)
        val start = ScrubBubblePlacement.place(0, 500, 400, 20, 0f, 100, 80, 600, 8)
        assertEquals(0, start.x)
        val end = ScrubBubblePlacement.place(100, 500, 500, 20, 1f, 100, 80, 600, 8)
        assertEquals(500, end.x)
        // Too little room above: it stays inside the window rather than off its top.
        assertEquals(0, ScrubBubblePlacement.place(0, 40, 400, 20, 0.3f, 100, 80, 600, 8).y)
        assertEquals(0, ScrubBubblePlacement.place(0, 500, 400, 20, Float.NaN, 100, 80, 600, 8).x)
    }

    @Test
    fun `the last request wins while a frame is being read, and a frame read once is not read again`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val asked = mutableListOf<Long>()
        val frames = ScrubFrames<String>(backgroundScope) { at -> asked += at; if (at == 1_000L) gate.await(); "f$at" }
        frames.request(1_000); runCurrent()
        frames.request(2_000); frames.request(3_000); runCurrent()
        assertEquals(listOf(1_000L), asked)
        gate.complete(Unit); runCurrent()
        assertEquals(listOf(1_000L, 3_000L), asked)
        assertEquals(ScrubFrame(3_000L, "f3000"), frames.shown.value)
        frames.request(1_000); runCurrent()
        assertEquals(2, frames.reads)
        assertEquals(ScrubFrame(1_000L, "f1000"), frames.shown.value)
    }

    @Test
    fun `frames are kept in memory up to the capacity, least recently used out first`() = runTest {
        val frames = ScrubFrames<String>(backgroundScope, capacity = 2) { at -> "f$at" }
        for (at in listOf(1_000L, 2_000L, 3_000L)) { frames.request(at); runCurrent() }
        frames.request(3_000); runCurrent()
        assertEquals(3, frames.reads)
        frames.request(1_000); runCurrent()
        assertEquals(4, frames.reads)
    }

    @Test
    fun `reads that give nothing stop after three in a row, and a frame resets the count`() = runTest {
        var good = setOf(2_000L)
        val frames = ScrubFrames<String>(backgroundScope, maxFailures = 3) { at -> if (at in good) "f$at" else throw IllegalStateException("no frame") }
        for (at in listOf(1_000L, 2_000L, 3_000L, 4_000L)) { frames.request(at); runCurrent() }
        assertFalse(frames.gaveUp)
        good = emptySet()
        for (at in listOf(5_000L, 6_000L, 7_000L, 8_000L)) { frames.request(at); runCurrent() }
        assertTrue(frames.gaveUp)
        // 5 000 was the third failure in a row; 6 000 to 8 000 were never read.
        assertEquals(5, frames.reads)
        assertEquals(ScrubFrame(2_000L, "f2000"), frames.shown.value)
    }

    @Test
    fun `closing drops the frames and a read still in flight`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val frames = ScrubFrames<String>(backgroundScope) { gate.await(); "late" }
        frames.request(5_000); runCurrent()
        frames.close()
        gate.complete(Unit); runCurrent()
        assertNull(frames.shown.value)
        frames.request(6_000); runCurrent()
        assertEquals(1, frames.reads)
        assertNull(frames.shown.value)
    }
}
