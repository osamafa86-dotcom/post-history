"use client";
import { useEffect, useRef } from "react";
import type shaka from "shaka-player/dist/shaka-player.ui";
import { messages, type Locale } from "@/lib/i18n";
import { allowPlayerRequest, playerControls, playerSource } from "@/lib/player-policy";
import "@/generated/player.css";
import "./material-player.css";

export function MaterialPlayer({ source, locale, onUnavailable }: { source: string; locale: Locale; onUnavailable: () => void }) {
  const host = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), unavailable = useRef(onUnavailable);
  useEffect(() => { unavailable.current = onUnavailable; }, [onUnavailable]);
  useEffect(() => {
    const container = host.current, media = video.current;
    if (!container || !media) return;
    let disposed = false, notified = false;
    let player: shaka.Player | undefined, ui: shaka.ui.Overlay | undefined;
    const fail = () => { if (!disposed && !notified) { notified = true; unavailable.current(); } };
    media.addEventListener("error", fail);
    const start = async () => {
      const library = (await import("shaka-player/dist/shaka-player.ui")).default;
      if (disposed) return;
      const url = playerSource(source, location.origin);
      library.polyfill.installAll();
      player = new library.Player();
      player.addEventListener("error", fail);
      player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
        if (!allowPlayerRequest(request.uris, url)) throw new Error("Invalid preview request");
        request.allowCrossSiteCredentials = false;
      });
      player.configure({ streaming: { retryParameters: { maxAttempts: 1 } } });
      await player.attach(media);
      if (disposed) return;
      ui = new library.ui.Overlay(player, container, media);
      ui.configure(playerControls);
      player.configure({ textDisplayFactory: (p: shaka.Player) => new library.text.UITextDisplayer(p), textDisplayer: { fontFamily: "system-ui" } });
      ui.getControls()?.getLocalization()?.changeLocale([locale]);
      await player.load(url, 0, "video/mp4");
    };
    void start().catch(fail);
    return () => {
      disposed = true; media.removeEventListener("error", fail);
      void (ui ? ui.destroy() : player?.destroy())?.catch(() => {});
    };
  }, [source, locale]);
  const m = messages[locale];
  return <div ref={host} className="material-player" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} data-testid="material-player">
    <video ref={video} aria-label={m.preview} playsInline preload="metadata" controlsList="nodownload" disablePictureInPicture disableRemotePlayback>{m.videoUnsupported}</video>
    <span className="watermark">{m.watermark}</span>
  </div>;
}
