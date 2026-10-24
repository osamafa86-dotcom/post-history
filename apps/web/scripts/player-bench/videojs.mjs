import React from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer, CompatVideoSkin } from "@videojs/react/video";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { I18nProvider } from "@videojs/react/i18n";
import ar from "@videojs/react/i18n/locales/ar";
import "@videojs/react/video/compat-skin.css";

const fixture = new URLSearchParams(location.search).get("fixture");
if (!["vfr-offset", "hdr-hlg"].includes(fixture)) throw new Error("Unknown synthetic fixture");
const base = new URL(`/fixtures/${fixture}/`, location.origin).href;
const h = React.createElement;
createRoot(document.getElementById("player")).render(
  h(I18nProvider, { locale: "ar", translations: ar },
    h(VideoPlayer, null, h(CompatVideoSkin, { className: "bench-player" },
      h(HlsJsVideo, { source: { src: `${base}hls/index.m3u8`, engine: { hlsJs: { enableWorker: false } } },
        muted: true, playsInline: true, preload: "auto", fallback: null,
        onError: () => { document.body.dataset.playerError = "true"; } },
        h("track", { kind: "subtitles", src: `${base}captions.ar.vtt`, srcLang: "ar", label: "العربية", default: true }),
        h("track", { kind: "metadata", src: `${base}timeline/thumbnails.vtt`, label: "thumbnails", default: true }),
      ),
    )),
  ),
);
