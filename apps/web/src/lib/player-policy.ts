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
