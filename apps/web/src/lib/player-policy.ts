const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const mediaPath = new RegExp(`^/api/bff/materials/${uuid}/files/${uuid}/content$`, "i");
export function playerSource(path: string, origin: string) {
  if (!mediaPath.test(path)) throw new Error("Invalid preview source");
  return new URL(path, origin).href;
}
export function allowPlayerRequest(uris: string[], source: string) {
  return uris.length > 0 && uris.every(uri => uri === source);
}
export const playerControls = {
  enableKeyboardPlaybackControls: true, enableKeyboardPlaybackControlsInWindow: false,
  controlPanelElements: ["play_pause", "time_and_duration", "mute", "volume", "captions", "fullscreen"],
  overflowMenuButtons: [], keyboardSeekDistance: 5, keyboardLargeSeekDistance: 10,
  alwaysShowVolumeBar: true, customContextMenu: true, contextMenuElements: [], mediaSession: { enabled: false },
};
/** نوع النسخة الخفيفة كما ينتجها عامل الوسائط: H.264 High وAAC-LC في MP4. */
export const proxyType = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
/**
 * النوع الذي يُعلَن للمشغّل: بمرمِّزَيه حين يقول المتصفح إنه يشغّلهما، فلا يُسأل عن `video/mp4` بلا مرمِّز (سؤال يحذّر منه المتصفح عند كل
 * تحميل). وإلا النوع العام، ويبقى الحكم للمتصفح عند التحميل.
 */
export const playerType = (canPlay: (type: string) => string) => canPlay(proxyType) ? proxyType : "video/mp4";
