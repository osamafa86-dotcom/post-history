import shaka from "shaka-player/dist/shaka-player.ui.js";
import "shaka-player/dist/controls.css";

const fixture = new URLSearchParams(location.search).get("fixture");
if (!["vfr-offset", "hdr-hlg"].includes(fixture)) throw new Error("Unknown synthetic fixture");
const base = new URL(`/fixtures/${fixture}/`, location.origin).href;
shaka.polyfill.installAll();
const container = document.getElementById("player");
const video = document.createElement("video");
video.muted = true;
video.playsInline = true;
container.append(video);
const player = new shaka.Player();
await player.attach(video);
const ui = new shaka.ui.Overlay(player, container, video);
// عرض الترجمة فوق أدوات التحكم؛ اتجاه النص المختلط ما زال جزءًا من بوابة القياس.
player.configure({ textDisplayFactory: p => new shaka.text.UITextDisplayer(p),
  textDisplayer: { fontFamily: "system-ui" } });
ui.configure({ enableKeyboardPlaybackControls: true, enableKeyboardPlaybackControlsInWindow: false,
  controlPanelElements: ["play_pause", "time_and_duration", "mute", "volume", "captions", "fullscreen"],
  overflowMenuButtons: [], keyboardSeekDistance: 5, keyboardLargeSeekDistance: 10 });
ui.getControls().getLocalization().changeLocale(["ar"]);
player.addEventListener("error", () => { document.body.dataset.playerError = "true"; });
await player.load(`${base}hls/index.m3u8`);
const captions = await player.addTextTrackAsync(`${base}captions.ar.vtt`, "ar", "subtitles", "text/vtt", "", "العربية");
player.selectTextTrack(captions);
await player.addThumbnailsTrack(`${base}timeline/thumbnails.vtt`, "text/vtt");
document.body.dataset.playerReady = "true";
window.addEventListener("pagehide", () => { void ui.destroy(); }, { once: true });
