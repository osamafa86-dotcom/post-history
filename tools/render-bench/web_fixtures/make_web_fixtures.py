"""مواد اختبار مشغّل الويب (#89) بكود العامل نفسه، بلا أي ملف حقيقي: لكل حالة HLS fMP4 والنسخة الخفيفة، وصور شريط
الزمن (`timeline/sprite.jpg` و`thumbnails.vtt`)، وترجمة عربية WebVTT (`captions.ar.vtt`)، و`manifest.json` بما
يتوقعه الاختبار. الحالات: 1080p بمعدل متغير وبداية 2 ث، وHEVC 10 بت HLG يُحوَّل إلى SDR.

    docker run --rm -v "$PWD/tools/render-bench/web_fixtures:/wf:ro" -v /tmp/wf:/out media-worker:test \\
        python /wf/make_web_fixtures.py /out
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from media_worker.ffmpeg import FFMPEG, run
from media_worker.hls import make_hls
from media_worker.probe import probe
from media_worker.proxy import make_proxy
from media_worker.thumbnails import timeline_sprite

SECONDS = 12
HLG = ["-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
       "log-level=error:pools=none:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
       "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"]
CASES = {
    "vfr-offset": ["-vf", "select='not(eq(mod(n,7),3))'", "-fps_mode", "vfr", "-c:v", "libx264", "-preset",
                   "ultrafast", "-pix_fmt", "yuv420p", "-output_ts_offset", "2"],
    "hdr-hlg": HLG,
}
# عبارات بالعربية مع أرقام وكلمة لاتينية، لاختبار اتجاه السطر والمحاذاة واتجاه الأرقام داخل السطر
CAPTIONS = [
    (0.5, 3.5, "مرحبًا، هذه ترجمة تجريبية للمشغّل."),
    (4.0, 7.5, "وصل المراسل إلى الموقع الساعة 10:30 مع فريق Reuters."),
    (8.0, 11.5, "سطر أول\nوسطر ثانٍ في الإشارة نفسها."),
]


def captions(path: Path) -> None:
    def t(s: float) -> str:
        return f"00:00:{int(s):02d}.{round(s % 1 * 1000):03d}"
    lines = ["WEBVTT", "Language: ar", ""]
    for i, (a, b, text) in enumerate(CAPTIONS, 1):
        lines += [str(i), f"{t(a)} --> {t(b)} align:center", text, ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def main(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, enc in CASES.items():
        d = out / name
        d.mkdir(exist_ok=True)
        src = d / "source.mov"
        run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={SECONDS}",
             "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SECONDS}",
             *enc, "-c:a", "aac", str(src)], timeout_s=300)
        info = probe(src)
        proxy = make_proxy(src, d / "proxy.mp4", info)
        src.unlink()
        hls = make_hls(d / "proxy.mp4", d / "hls", proxy.duration_ms)
        vtt, sprite = timeline_sprite(d / "proxy.mp4", d / "timeline", proxy)
        captions(d / "captions.ar.vtt")
        manifest[name] = {
            "source_hdr": info.hdr, "source_vfr": info.vfr, "start_pts_us": proxy.start_pts_us,
            "width": proxy.width, "height": proxy.height, "duration_ms": proxy.duration_ms,
            "hls": "hls/index.m3u8", "segments": sum(1 for p in hls if p.suffix == ".m4s"),
            "proxy": "proxy.mp4", "thumbnails": "timeline/thumbnails.vtt", "captions": "captions.ar.vtt",
            "thumbnail_cues": vtt.read_text().count("#xywh="), "caption_cues": len(CAPTIONS),
        }
        print(name, json.dumps(manifest[name]))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
