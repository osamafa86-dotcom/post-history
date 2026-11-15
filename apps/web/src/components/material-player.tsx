"use client";
import { useEffect, useRef } from "react";
import type shaka from "shaka-player/dist/shaka-player.ui";
import { messages, type Locale } from "@/lib/i18n";
import { allowPlayerRequest, playerControls, playerSource, playerType } from "@/lib/player-policy";
import { pictureBox, previewShape, type PreviewShape } from "@/lib/preview-policy";
import "@/generated/player.css";
import "./material-player.css";

/** `shape`: شكل الإطار من أبعاد الملف كما يعيدها الخادم؛ بلاها يؤخذ من أبعاد المقطع نفسه حين تُعرف. */
export function MaterialPlayer({ source, locale, onUnavailable, shape }: { source: string; locale: Locale; onUnavailable: () => void; shape?: PreviewShape }) {
  const host = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), unavailable = useRef(onUnavailable);
  useEffect(() => { unavailable.current = onUnavailable; }, [onUnavailable]);
  useEffect(() => {
    const container = host.current, media = video.current;
    if (!container || !media) return;
    let disposed = false, notified = false;
    let player: shaka.Player | undefined, ui: shaka.ui.Overlay | undefined;
    const fail = () => { if (!disposed && !notified) { notified = true; unavailable.current(); } };
    media.addEventListener("error", fail);
    // العلامة المائية على مساحة الصورة نفسها: تُحسب من أبعاد المقطع والإطار، وتُعاد عند تغيّر أحدهما (ملء الشاشة، تدوير الهاتف).
    const place = () => { const box = pictureBox(container.clientWidth, container.clientHeight, media.videoWidth, media.videoHeight); for (const key of ["x", "y", "w"] as const) container.style.setProperty(`--picture-${key}`, `${box[key]}px`); };
    const measured = () => { if (!shape) container.dataset.shape = previewShape(media.videoWidth, media.videoHeight); place(); };
    media.addEventListener("loadedmetadata", measured);
    const frame = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null; frame?.observe(container);
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
      // اسم شريط التقدّم من نصوصنا: ترجمة المكتبة العربية له لا تُفهم لقارئ الشاشة.
      const words = ui.getControls()?.getLocalization(); words?.insert(locale, new Map([["SEEK", messages[locale].playerSeek]])); words?.changeLocale([locale]);
      await player.load(url, 0, playerType(type => media.canPlayType(type)));
    };
    void start().catch(fail);
    return () => {
      disposed = true; frame?.disconnect(); media.removeEventListener("error", fail); media.removeEventListener("loadedmetadata", measured);
      void (ui ? ui.destroy() : player?.destroy())?.catch(() => {});
    };
  }, [source, locale, shape]);
  const m = messages[locale];
  return <div ref={host} className="material-player" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} data-testid="material-player" data-shape={shape ?? "landscape"}>
    <video ref={video} aria-label={m.preview} playsInline preload="metadata" controlsList="nodownload" disablePictureInPicture disableRemotePlayback>{m.videoUnsupported}</video>
    <span className="watermark">{m.watermark}</span>
  </div>;
}
