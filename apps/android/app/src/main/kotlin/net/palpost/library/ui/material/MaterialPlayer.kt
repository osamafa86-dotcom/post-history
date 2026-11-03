package net.palpost.library.ui.material

import android.app.Activity
import android.content.pm.ActivityInfo
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.VolumeOff
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.SkipNext
import androidx.compose.material.icons.outlined.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.api.models.Material
import net.palpost.library.api.models.MaterialFile
import net.palpost.library.core.materials.MaterialMedia
import net.palpost.library.core.materials.PlaybackQuality
import net.palpost.library.core.materials.PlaybackSource
import net.palpost.library.core.materials.PlaybackSourcePolicy
import net.palpost.library.core.materials.ScrubBubblePlacement
import net.palpost.library.core.materials.ScrubFrame
import net.palpost.library.core.materials.ScrubFrames
import net.palpost.library.core.materials.ScrubPreviewPolicy
import net.palpost.library.core.materials.ScrubPreviewSource
import net.palpost.library.core.materials.SignedUrlLease
import net.palpost.library.core.materials.SignedUrlRefresh
import net.palpost.library.ui.theme.GhostButton
import net.palpost.library.ui.theme.MinTouchTarget
import net.palpost.library.ui.theme.Vl
import net.palpost.library.ui.theme.VlIcon
import net.palpost.library.ui.theme.tokens.VlRadius
import net.palpost.library.ui.theme.tokens.VlSpace
import java.util.UUID

/**
 * One player at a time (iOS `PlaybackCenter`). The emergency wipe, sign-out and revocation call [stopAll] first: every player
 * stops, drops its item and its link, and is released, before the files it may read are erased. Players live on the main thread.
 */
class PlaybackCenter {
    private val players = LinkedHashSet<ExoPlayer>()
    private val previews = LinkedHashSet<AutoCloseable>()
    private val main = Handler(Looper.getMainLooper())
    @Volatile var generation = 0; private set

    fun register(p: ExoPlayer) {
        // A new player stops the others: one plays at a time.
        for (o in players.toList()) if (o !== p) o.pause()
        players.add(p)
    }

    fun unregister(p: ExoPlayer) { players.remove(p) }

    /** The seek bar's frames (ADR 0106): they never pause a player, and they go with the players. */
    fun registerPreview(c: AutoCloseable) = synchronized(previews) { previews.add(c) }

    fun unregisterPreview(c: AutoCloseable) = synchronized(previews) { previews.remove(c) }

    fun stopAll() {
        generation++
        // The frames first, on the caller's thread: their link and pictures go before anything else is erased.
        val frames = synchronized(previews) { previews.toList().also { previews.clear() } }
        for (c in frames) runCatching { c.close() }
        val run = Runnable {
            for (p in players.toList()) { p.stop(); p.clearMediaItems(); p.release() }
            players.clear()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    }
}

/** Where the inline player was, handed to the fullscreen one and back, so switching never starts the video over. Memory only. */
class PlayerHandoff {
    var positionMs = 0L
    var playing = false
}

private val SPEEDS = listOf(0.5f, 1f, 1.5f, 2f)
private const val FRAME_MS = 33L

/**
 * The material's player (09, and 08 inline), over Media3 with the app's own controls: play and pause, a seek bar with a 48dp
 * target and, while it is dragged, a bubble above the thumb with the time and a frame of the verified light copy (ADR 0106),
 * speed 0.5×–2×, frame by frame, mute, fullscreen (dark, landscape for a landscape video) and the quality as a word.
 * The source is the phone's original first, then verified HLS, then the verified light copy (`PlaybackSourcePolicy`); a remote
 * link is asked for just before playing, kept in memory only, renewed when it lapses, and never more than twice without progress.
 * No sharing, no picture-in-picture, no media session, so nothing shows on the lock screen; the window is secure, so neither
 * screenshots nor screen recording show it. Nothing about the material is logged.
 */
@OptIn(UnstableApi::class)
@Composable
fun MaterialPlayer(
    container: AppContainer, material: Material, initial: PlaybackSource, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit,
    modifier: Modifier = Modifier, handoff: PlayerHandoff? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val player = remember {
        // No cache module: what is streamed is not written to disk. Content URIs (the phone's original) go through the same factory.
        val data = DefaultDataSource.Factory(context, DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(false))
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(data)).build().also { container.playback.register(it) }
    }
    val startGeneration = remember { container.playback.generation }
    var source by remember(initial) { mutableStateOf(initial) }
    var lease by remember { mutableStateOf<SignedUrlLease?>(null) }
    var refreshes by remember { mutableIntStateOf(0) }
    var failed by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableLongStateOf(handoff?.positionMs ?: 0L) }
    var duration by remember { mutableLongStateOf(MaterialMedia.durationMs(material) ?: 0L) }
    var speed by remember { mutableFloatStateOf(1f) }
    var muted by remember { mutableStateOf(false) }
    var prepared by remember { mutableStateOf(false) }
    var landscape by remember { mutableStateOf(false) }
    var scrubbing by remember { mutableStateOf(false) }

    // The seek bar's frames: from the verified light copy alone, read only once the reporter drags (ADR 0106).
    val preview = remember(material, source) { ScrubPreviewPolicy.source(material, source) }
    val density = LocalDensity.current
    val framePx = remember(density) { with(density) { BUBBLE_FRAME_MAX.roundToPx() } }
    var session by remember { mutableStateOf<ScrubSession?>(null) }
    DisposableEffect(preview) {
        onDispose {
            session?.let { container.playback.unregisterPreview(it); it.close() }
            session = null
        }
    }
    fun scrubFrames(): ScrubFrames<ImageBitmap>? {
        val p = preview as? ScrubPreviewSource.LightCopy ?: return null
        if (container.playback.generation != startGeneration) return null
        session?.let { return it.frames }
        val fileId = UUID.fromString(p.fileId)
        val made = ScrubSession(scope, { runCatching { SignedUrlLease.of(container.materialsApi.getMaterialFileDownloadUrl(material.id, fileId)) }.getOrNull() }, framePx)
        container.playback.registerPreview(made)
        session = made
        return made.frames
    }
    val shownFlow: StateFlow<ScrubFrame<ImageBitmap>?> = remember(session) { session?.frames?.shown ?: MutableStateFlow<ScrubFrame<ImageBitmap>?>(null) }
    val shown by shownFlow.collectAsState()

    suspend fun mediaItem(s: PlaybackSource): MediaItem? = when (s) {
        is PlaybackSource.Local -> MediaItem.fromUri(s.original.uri)
        is PlaybackSource.Remote -> {
            val current = lease
            val fresh = if (SignedUrlRefresh.beforePlayback(current, System.currentTimeMillis()) == SignedUrlRefresh.Decision.USE_CURRENT) current
            else runCatching { SignedUrlLease.of(container.materialsApi.getMaterialFileDownloadUrl(material.id, UUID.fromString(s.fileId))) }.getOrNull()
            lease = fresh
            fresh?.let {
                val b = MediaItem.Builder().setUri(it.url)
                if (s.kind == MaterialFile.Kind.hls) b.setMimeType(MimeTypes.APPLICATION_M3U8)
                b.build()
            }
        }
        PlaybackSource.Unavailable -> null
    }

    suspend fun start(at: Long, play: Boolean) {
        if (container.playback.generation != startGeneration) return
        val item = mediaItem(source) ?: run { failed = true; return }
        player.setMediaItem(item, at)
        player.prepare()
        prepared = true
        player.playWhenReady = play
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying; handoff?.playing = isPlaying; if (isPlaying) { failed = false } }
            override fun onPlaybackStateChanged(state: Int) {
                if (player.duration > 0) duration = player.duration
                if (state == Player.STATE_READY) refreshes = 0
            }
            override fun onVideoSizeChanged(videoSize: androidx.media3.common.VideoSize) { landscape = videoSize.width > videoSize.height }
            override fun onPlayerError(error: PlaybackException) {
                val at = player.currentPosition
                scope.launch {
                    when (SignedUrlRefresh.afterFailure(lease, System.currentTimeMillis(), refreshes)) {
                        SignedUrlRefresh.Decision.FETCH_NEW -> if (source is PlaybackSource.Remote) { refreshes++; lease = null; start(at, true) } else failed = true
                        else -> {
                            val next = PlaybackSourcePolicy.fallback(source, material)
                            if (next != null) { source = next; lease = null; refreshes = 0; start(at, true) } else failed = true
                        }
                    }
                }
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            container.playback.unregister(player)
            player.release()
            lease = null
        }
    }
    LaunchedEffect(player, playing) {
        while (playing) { position = player.currentPosition; handoff?.positionMs = position; delay(250) }
        position = player.currentPosition
        handoff?.positionMs = position
    }
    // Coming from the other player (inline ↔ fullscreen) while it played: go on from the same moment.
    LaunchedEffect(player) { if (handoff?.playing == true) start(position, true) }
    // Fullscreen asks for landscape for a landscape video and gives the phone back its orientation on the way out.
    DisposableEffect(fullscreen, landscape) {
        val activity = context as? Activity
        if (fullscreen && landscape) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        onDispose { activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }

    fun toggle() {
        if (playing) { player.pause(); return }
        scope.launch {
            if (!prepared || failed || (source is PlaybackSource.Remote && SignedUrlRefresh.beforePlayback(lease, System.currentTimeMillis()) == SignedUrlRefresh.Decision.FETCH_NEW)) {
                failed = false; start(position, true)
            } else player.play()
        }
    }

    Box(modifier.background(Color.Black)) {
        AndroidView(
            factory = { ctx -> PlayerView(ctx).apply { useController = false; this.player = player } },
            update = { it.player = player },
            modifier = Modifier.fillMaxSize(),
        )
        Controls(
            playing = playing, position = position, duration = duration, speed = speed, muted = muted, fullscreen = fullscreen, failed = failed,
            quality = source.quality, scrubbing = scrubbing, frame = shown?.frame,
            onToggle = ::toggle,
            onSeek = {
                player.setSeekParameters(SeekParameters.CLOSEST_SYNC); player.seekTo(it); position = it
                scrubbing = true
                scrubFrames()?.request(ScrubPreviewPolicy.bucket(it, duration))
            },
            onSeekDone = { scrubbing = false; player.setSeekParameters(SeekParameters.EXACT) },
            onStep = { forward ->
                player.pause()
                player.setSeekParameters(SeekParameters.EXACT)
                val to = (player.currentPosition + if (forward) FRAME_MS else -FRAME_MS).coerceIn(0, duration.coerceAtLeast(0))
                player.seekTo(to); position = to
            },
            onSpeed = { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.size]; player.setPlaybackSpeed(speed) },
            onMute = { muted = !muted; player.volume = if (muted) 0f else 1f },
            onFullscreen = { onFullscreen(!fullscreen) },
            onRetry = { failed = false; refreshes = 0; lease = null; scope.launch { start(position, true) } },
        )
    }
}

/**
 * The controls: always left to right as in the frames (the title and close around them follow the app's language), each target
 * 48dp, each with a name for TalkBack; the seek bar reads «0:37 of 1:42» and steps by ten seconds. While it is dragged, a bubble
 * above the thumb shows the time and, when there is one, the frame read for that moment (TalkBack reads the bar, not the bubble).
 */
@Composable
private fun BoxScope.Controls(
    playing: Boolean, position: Long, duration: Long, speed: Float, muted: Boolean, fullscreen: Boolean, failed: Boolean, quality: PlaybackQuality?,
    scrubbing: Boolean, frame: ImageBitmap?,
    onToggle: () -> Unit, onSeek: (Long) -> Unit, onSeekDone: () -> Unit, onStep: (Boolean) -> Unit, onSpeed: () -> Unit,
    onMute: () -> Unit, onFullscreen: () -> Unit, onRetry: () -> Unit,
) {
    val white = Color.White
    if (failed) {
        Column(Modifier.align(Alignment.Center).padding(VlSpace.s4), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.player_failed), style = Vl.text.body, color = white)
            GhostButton(stringResource(R.string.action_retry), onRetry)
        }
    }
    val timeLabel = stringResource(R.string.player_time_of, MaterialMedia.clock(position), MaterialMedia.clock(duration))
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = VlSpace.s3)) {
            val fraction = if (duration > 0) position.toFloat() / duration else 0f
            Box(Modifier.fillMaxWidth()) {
                Slider(
                    value = fraction,
                    onValueChange = { onSeek((it * duration).toLong()) }, onValueChangeFinished = onSeekDone,
                    colors = SliderDefaults.colors(thumbColor = white, activeTrackColor = white, inactiveTrackColor = white.copy(alpha = 0.3f)),
                    modifier = Modifier.fillMaxWidth().heightIn(min = MinTouchTarget).semantics { contentDescription = timeLabel },
                )
                if (scrubbing) ScrubBubble(fraction, frame, MaterialMedia.clock(position))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(VlSpace.s2)) {
                Text("${MaterialMedia.clock(position)} / ${MaterialMedia.clock(duration)}", style = Vl.text.num, color = white, modifier = Modifier.weight(1f))
                quality?.let { Text(qualityWord(it), style = Vl.text.caption, color = white) }
                Button(if (muted) Icons.AutoMirrored.Outlined.VolumeOff else Icons.AutoMirrored.Outlined.VolumeUp, stringResource(if (muted) R.string.player_unmute else R.string.player_mute), onMute)
                Button(if (fullscreen) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen, stringResource(if (fullscreen) R.string.player_exit_fullscreen else R.string.player_fullscreen), onFullscreen)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceEvenly) {
                Button(Icons.Outlined.SkipPrevious, stringResource(R.string.player_frame_back)) { onStep(false) }
                Button(if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, stringResource(if (playing) R.string.player_pause else R.string.player_play), onToggle)
                val speedText = (if (speed % 1f == 0f) speed.toInt().toString() else speed.toString()) + "×"
                val speedLabel = stringResource(R.string.player_speed, speedText)
                Box(Modifier.size(MinTouchTarget).semantics { contentDescription = speedLabel; stateDescription = speedText }, contentAlignment = Alignment.Center) {
                    GhostButton(speedText, onSpeed)
                }
                Button(Icons.Outlined.SkipNext, stringResource(R.string.player_frame_forward)) { onStep(true) }
            }
        }
    }
}

/** The largest frame in the bubble, wide or tall; the reader scales frames down to fit it (ADR 0106). */
private val BUBBLE_FRAME_MAX = 144.dp
private val BUBBLE_GAP = 8.dp
// Where the thumb's centre sits at each end of the bar; a few dp either way only nudges the bubble.
private val SLIDER_INSET = 8.dp

/**
 * The bubble while dragging: a popup over the player (the inline player is too short to hold it under its own clip), centred
 * over the thumb and kept inside the window, the frame if one was read and the time beneath it. Not focusable, so the drag stays
 * on the bar; the secure flag is set on its window, so it shows in no screenshot or recording.
 */
@Composable
private fun ScrubBubble(fraction: Float, frame: ImageBitmap?, time: String) {
    val density = LocalDensity.current
    val position = remember(fraction, density) {
        with(density) { ScrubBubblePosition(fraction, SLIDER_INSET.roundToPx(), BUBBLE_GAP.roundToPx()) }
    }
    Popup(popupPositionProvider = position, properties = PopupProperties(focusable = false, dismissOnClickOutside = false, securePolicy = SecureFlagPolicy.SecureOn)) {
        Column(
            Modifier.clearAndSetSemantics {}.background(Color.Black.copy(alpha = 0.8f), RoundedCornerShape(VlRadius.sm)).padding(VlSpace.s1),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(VlSpace.s1),
        ) {
            if (frame != null && frame.height > 0) {
                Image(
                    frame, contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier.sizeIn(maxWidth = BUBBLE_FRAME_MAX, maxHeight = BUBBLE_FRAME_MAX * 0.75f).aspectRatio(frame.width.toFloat() / frame.height).clip(RoundedCornerShape(VlRadius.sm)),
                )
            }
            Text(time, style = Vl.text.num, color = Color.White, modifier = Modifier.padding(horizontal = VlSpace.s2))
        }
    }
}

private class ScrubBubblePosition(private val fraction: Float, private val insetPx: Int, private val gapPx: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val at = ScrubBubblePlacement.place(
            anchorLeft = anchorBounds.left, anchorTop = anchorBounds.top, anchorWidth = anchorBounds.width, insetPx = insetPx, fraction = fraction,
            bubbleWidth = popupContentSize.width, bubbleHeight = popupContentSize.height, windowWidth = windowSize.width, gapPx = gapPx,
        )
        return IntOffset(at.x, at.y)
    }
}

@Composable
private fun Button(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(MinTouchTarget)) {
        Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(VlIcon.md))
    }
}

/** The quality as a word: the original, the light copy with its lines, or HLS. */
@Composable
fun qualityWord(q: PlaybackQuality): String = when (q) {
    PlaybackQuality.Original -> stringResource(R.string.player_quality_original)
    PlaybackQuality.Adaptive -> stringResource(R.string.player_quality_hls)
    is PlaybackQuality.LightCopy -> q.lines?.let { stringResource(R.string.player_quality_light_lines, it) } ?: stringResource(R.string.player_quality_light)
}
