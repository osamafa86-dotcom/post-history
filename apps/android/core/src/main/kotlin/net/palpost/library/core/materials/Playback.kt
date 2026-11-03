package net.palpost.library.core.materials

import net.palpost.library.api.models.FileDownloadUrl
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.core.upload.UploadState
import java.net.URI

// The viewing source in My materials, the detail and the player (ADR 0089, as on iOS), by the coordinator's order:
// 1. the original on this phone while it is still there (the picked gallery file, until the reporter deletes it after the receipt);
// 2. else a verified derivative on the server through `getMaterialFileDownloadUrl`: `hls` then `proxy` to play, `thumbnail` for the
//    gallery; never a link for the original (the contract refuses it) or for a file not yet verified;
// 3. else an explicit «processing» state.

/** A queue row on this phone, as the source rules need it. */
data class LocalRecord(
    val id: String,
    val materialId: String,
    val kind: String,
    val sha256: String?,
    val state: UploadState,
    val createdAtEpochMs: Long,
    val mimeType: String?,
    val uri: String,
)

/** The material's original on this phone. */
data class LocalOriginal(val recordId: String, val uri: String, val mimeType: String?) {
    val isImage: Boolean get() = mimeType?.lowercase()?.startsWith("image/") == true
}

/** Why there is no phone copy to show, as the «processing» line says it. */
enum class LocalOriginalAbsence { NOT_ON_PHONE, REMOVED_FROM_PHONE, NOT_THE_VERIFIED_ORIGINAL }

object LocalOriginals {
    /**
     * The material's original on this phone by what the desk has, not by the newest, so a replacement shot still on its way or
     * refused (409 for a second original after verification) is never shown as the original:
     * 1. a verified original with a digest on the server: the row whose digest matches it, else a row with no digest kept that
     *    the server confirmed; never a row with another digest, one still uploading, failed or not sent;
     * 2. a verified original without a digest: a row the server confirmed (`verified` or `deduplicated`), the newest;
     * 3. no verified original yet: the newest row still on its way (queued, uploading, or awaiting its receipt).
     * A failed (refused) row is never shown, and the phone copy is a condition in all three ([hasLocalCopy]). iOS falls back to any
     * row in case 3; Android does not (ADR 0095), so a refused replacement never shows as the original.
     */
    fun find(material: Material, records: List<LocalRecord>, hasLocalCopy: (LocalRecord) -> Boolean): LocalOriginal? {
        val candidates = records.filter { it.materialId == material.id.toString() && it.kind == "original" && hasLocalCopy(it) }
        if (candidates.isEmpty()) return null
        fun newest(list: List<LocalRecord>) = list.maxByOrNull { it.createdAtEpochMs }
        val verified = material.files.filter { it.kind == MaterialFile.Kind.original && it.state == MaterialFile.State.verified }
        val hashes = verified.mapNotNull { it.sha256?.lowercase()?.takeIf(String::isNotEmpty) }.toSet()
        val chosen = when {
            hashes.isNotEmpty() -> newest(candidates.filter { r -> r.sha256?.lowercase()?.let { it in hashes } == true })
                ?: newest(candidates.filter { it.sha256.isNullOrEmpty() && confirmed(it.state) })
            verified.isNotEmpty() -> newest(candidates.filter { confirmed(it.state) })
            else -> newest(candidates.filter { it.state != UploadState.FAILED })
        }
        return chosen?.let { LocalOriginal(it.id, it.uri, it.mimeType) }
    }

    /** Why [find] found nothing, so «the original is not on this phone» is said only when true; null when a copy shows. */
    fun absence(material: Material, records: List<LocalRecord>, hasLocalCopy: (LocalRecord) -> Boolean): LocalOriginalAbsence? {
        if (find(material, records, hasLocalCopy) != null) return null
        val originals = records.filter { it.materialId == material.id.toString() && it.kind == "original" }
        return when {
            originals.isEmpty() -> LocalOriginalAbsence.NOT_ON_PHONE
            originals.none(hasLocalCopy) -> LocalOriginalAbsence.REMOVED_FROM_PHONE
            else -> LocalOriginalAbsence.NOT_THE_VERIFIED_ORIGINAL
        }
    }

    fun confirmed(s: UploadState): Boolean = s == UploadState.VERIFIED || s == UploadState.DEDUPLICATED
}

/** The quality as the player says it: the original, the light copy with its lines, or adaptive streaming. */
sealed interface PlaybackQuality {
    data object Original : PlaybackQuality
    data class LightCopy(val lines: Int?) : PlaybackQuality
    data object Adaptive : PlaybackQuality

    companion object {
        /** From the light copy's mode (urgent 360p, normal 540p, ADR 0075), else from the shorter side of its size. */
        fun lightCopy(f: MaterialFile): PlaybackQuality = when (f.proxyMode) {
            MaterialFile.ProxyMode.urgent -> LightCopy(360)
            MaterialFile.ProxyMode.normal -> LightCopy(540)
            else -> LightCopy(if (f.width != null && f.height != null) minOf(f.width!!, f.height!!).toInt() else null)
        }
    }
}

sealed interface PlaybackSource {
    data class Local(val original: LocalOriginal) : PlaybackSource
    /** A verified derivative; its link is asked for just before playing and never kept. */
    data class Remote(val fileId: String, val kind: MaterialFile.Kind, val remoteQuality: PlaybackQuality) : PlaybackSource
    /** «Processing — shown when the copy is ready». */
    data object Unavailable : PlaybackSource

    val quality: PlaybackQuality? get() = when (this) {
        is Local -> PlaybackQuality.Original
        is Remote -> remoteQuality
        Unavailable -> null
    }
}

/** What shows as a picture: a card's thumbnail, or the photo in the detail. */
sealed interface PreviewSource {
    data class Local(val original: LocalOriginal) : PreviewSource
    data class Remote(val fileId: String) : PreviewSource
    data object Unavailable : PreviewSource
}

/** The material carries a «yes» to any of the three questions: no cloud preview in the gallery (07c, CLAUDE.md §5). */
val Material.isSensitive: Boolean get() = sensitivity.minors || sensitivity.injured || sensitivity.graphic

object PlaybackSourcePolicy {
    /** The derivatives the contract gives a link for (`getMaterialFileDownloadUrl`); the original and the voice note are not. */
    val linkableKinds = setOf(
        MaterialFile.Kind.proxy, MaterialFile.Kind.hls, MaterialFile.Kind.audio, MaterialFile.Kind.thumbnail,
        MaterialFile.Kind.transcript, MaterialFile.Kind.captions, MaterialFile.Kind.shot_list,
    )

    fun newestVerified(kind: MaterialFile.Kind, m: Material, extra: (MaterialFile) -> Boolean = { true }): MaterialFile? {
        if (kind !in linkableKinds) return null
        return m.files.filter { it.kind == kind && it.state == MaterialFile.State.verified && extra(it) }.maxByOrNull { it.createdAt }
    }

    /** The player: the original on the phone → verified `hls` → verified `proxy` → «processing». */
    fun player(m: Material, local: LocalOriginal?): PlaybackSource {
        if (local != null) return PlaybackSource.Local(local)
        newestVerified(MaterialFile.Kind.hls, m)?.let { return PlaybackSource.Remote(it.id.toString(), MaterialFile.Kind.hls, PlaybackQuality.Adaptive) }
        newestVerified(MaterialFile.Kind.proxy, m)?.let { return PlaybackSource.Remote(it.id.toString(), MaterialFile.Kind.proxy, PlaybackQuality.lightCopy(it)) }
        return PlaybackSource.Unavailable
    }

    /** A sensitive material's picture stays concealed, blurred under the mark, wherever it comes from, until the reporter taps it. */
    fun conceals(m: Material, revealed: Boolean): Boolean = m.isSensitive && !revealed

    /**
     * An upload row on the phone: by [conceals] when the material is known from the server, else by the send's answer recorded at
     * «Send», else concealed (a replacement shot or an earlier release's row before My materials loads): hiding is safer.
     */
    fun concealsUpload(material: Material?, batchSensitive: Boolean?): Boolean =
        if (material != null) conceals(material, revealed = false) else batchSensitive ?: true

    /** The card's thumbnail: the original on the phone → verified `thumbnail` → none; a sensitive material asks the server for none. */
    fun thumbnail(m: Material, local: LocalOriginal?): PreviewSource {
        if (local != null) return PreviewSource.Local(local)
        if (m.isSensitive) return PreviewSource.Unavailable
        return newestVerified(MaterialFile.Kind.thumbnail, m)?.let { PreviewSource.Remote(it.id.toString()) } ?: PreviewSource.Unavailable
    }

    /** A photo material's picture in the detail: phone → light copy as a picture → thumbnail → none; a sensitive one only once tapped. */
    fun still(m: Material, local: LocalOriginal?, requested: Boolean): PreviewSource {
        if (conceals(m, requested)) return PreviewSource.Unavailable
        if (local != null) return PreviewSource.Local(local)
        newestVerified(MaterialFile.Kind.proxy, m) { it.mimeType?.lowercase()?.startsWith("image/") == true }?.let { return PreviewSource.Remote(it.id.toString()) }
        newestVerified(MaterialFile.Kind.thumbnail, m)?.let { return PreviewSource.Remote(it.id.toString()) }
        return PreviewSource.Unavailable
    }

    /** After `hls` fails: a verified `proxy` once before «could not play». No fallback after anything else. */
    fun fallback(after: PlaybackSource, m: Material): PlaybackSource? {
        if (after !is PlaybackSource.Remote || after.kind != MaterialFile.Kind.hls) return null
        val proxy = newestVerified(MaterialFile.Kind.proxy, m) ?: return null
        return PlaybackSource.Remote(proxy.id.toString(), MaterialFile.Kind.proxy, PlaybackQuality.lightCopy(proxy))
    }
}

/**
 * A short-lived signed read link (≤ 10 minutes, `Cache-Control: no-store`): in memory only for as long as it is watched, never
 * on disk or in a log. `https` with a host only.
 */
data class SignedUrlLease(val url: String, val expiresAtEpochMs: Long) {
    fun isFresh(nowMs: Long): Boolean = expiresAtEpochMs - nowMs > SAFETY_MARGIN_MS

    override fun toString(): String = "SignedUrlLease(redacted)"

    companion object {
        /** A link with less than this left does not start playback (the next range requests may arrive after it lapsed). */
        const val SAFETY_MARGIN_MS = 60_000L

        fun of(link: FileDownloadUrl): SignedUrlLease? = of(link.url.toString(), link.expiresAt.toInstant().toEpochMilli())

        fun of(url: String, expiresAtEpochMs: Long): SignedUrlLease? {
            val u = runCatching { URI(url) }.getOrNull() ?: return null
            if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty()) return null
            return SignedUrlLease(url, expiresAtEpochMs)
        }
    }
}

/** When to ask for a new link: before each start or resume, and after a failure with a bound so it never loops. */
object SignedUrlRefresh {
    enum class Decision { USE_CURRENT, FETCH_NEW, GIVE_UP }

    const val MAX_REFRESHES_WITHOUT_PROGRESS = 2

    fun beforePlayback(lease: SignedUrlLease?, nowMs: Long): Decision =
        if (lease != null && lease.isFresh(nowMs)) Decision.USE_CURRENT else Decision.FETCH_NEW

    /**
     * After the player failed: a lapsed or nearly lapsed link → a new one. A link still valid → one try with a new link (a passing
     * failure), then stop, because the link is not the cause. Never more than two refreshes without progress.
     */
    fun afterFailure(lease: SignedUrlLease?, nowMs: Long, refreshesWithoutProgress: Int): Decision = when {
        refreshesWithoutProgress >= MAX_REFRESHES_WITHOUT_PROGRESS -> Decision.GIVE_UP
        lease != null && lease.isFresh(nowMs) && refreshesWithoutProgress >= 1 -> Decision.GIVE_UP
        else -> Decision.FETCH_NEW
    }
}
