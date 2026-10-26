"""قياس المصغّرات من النسخة الخفيفة: زمن الملصق وصفيحة الاتصال من النسخة الخفيفة مقابل الأصل، وأبعادهما، وغياب
البيانات الكاشفة المزروعة وEXIF، ومتوسط إضاءة الملصق من المصدرين (لا انهيار ألوان HDR ولا إطار أسود).

مقاطع اصطناعية بصيغ الهواتف تحمل وسوم حاوية (موقع وطراز جهاز) ووسم تيار؛ لا ملف حقيقي ولا اتصال خارجي. التسجيل
(مصغّرة واحدة لكل أصل بـ `mime_type`) تثبته اختبارات `tests/test_jobs.py`. المخرج بمخطط
contracts/schemas/measurement.json.

    python bench/thumbnail_bench.py --out /results/<date>-thumbnail-from-proxy.json [--seconds 60]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from preview_slo import PROFILES  # noqa: E402

from media_worker import ffmpeg  # noqa: E402
from media_worker.ffmpeg import FFMPEG, run  # noqa: E402
from media_worker.probe import probe  # noqa: E402
from media_worker.proxy import make_proxy  # noqa: E402
from media_worker.thumbnails import contact_sheet, poster  # noqa: E402

PLANTED = {"com.apple.quicktime.location.ISO6709": "+00.0001+000.0001+000.000/",
           "com.apple.quicktime.make": "BenchMaker", "com.apple.quicktime.model": "BenchPhone 1"}
STREAM = {"comment": "bench-device-serial-0000"}
CASES = ("1080p-h264", "1080p-hlg", "4k-h264")
_YAVG = re.compile(r"lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)")


def make_clip(path: Path, profile: str, seconds: int) -> None:
    size, video = PROFILES[profile]
    tags = [a for k, v in PLANTED.items() for a in ("-metadata", f"{k}={v}")]
    stream = [a for k, v in STREAM.items() for a in ("-metadata:s:v:0", f"{k}={v}")]
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
         *video, "-an", "-movflags", "use_metadata_tags", *tags, *stream, str(path)], timeout_s=seconds * 60)


def yavg(jpg: Path) -> float:
    out = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(jpg),
               "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"],
              timeout_s=60).decode()
    return float(_YAVG.search(out).group(1))


def thumbs(src: Path, d: Path, tag: str) -> tuple[float, list]:
    info = probe(src)
    t = time.perf_counter()
    made = [poster(src, d / f"{tag}-poster.jpg", info), contact_sheet(src, d / f"{tag}-sheet.jpg", info)]
    return time.perf_counter() - t, made


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    started, metrics, leaks = now(), {}, 0
    planted = [v.encode() for v in [*PLANTED.values(), *STREAM.values()]]
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        for case in CASES:
            src = d / f"{case}.mov"
            make_clip(src, case, args.seconds)
            t = time.perf_counter()
            make_proxy(src, d / f"{case}-proxy.mp4")
            proxy_s = time.perf_counter() - t
            from_proxy_s, (p_poster, p_sheet) = thumbs(d / f"{case}-proxy.mp4", d, f"{case}-p")
            from_orig_s, (o_poster, _) = thumbs(src, d, f"{case}-o")
            blobs = [p_poster.path.read_bytes(), p_sheet.path.read_bytes()]
            found = sum(1 for b in blobs for v in planted if v in b)
            exif = sum(1 for b in blobs if b"Exif" in b)
            leaks += found + exif
            y_proxy, y_orig = yavg(p_poster.path), yavg(o_poster.path)
            metrics.update({
                f"{case}_proxy_s": round(proxy_s, 2),
                f"{case}_thumbnails_from_proxy_s": round(from_proxy_s, 2),
                f"{case}_thumbnails_from_original_s": round(from_orig_s, 2),
                f"{case}_poster_size": f"{p_poster.width}x{p_poster.height}",
                f"{case}_sheet_size": f"{p_sheet.width}x{p_sheet.height}",
                f"{case}_poster_yavg_from_proxy": round(y_proxy, 1),
                f"{case}_poster_yavg_from_original": round(y_orig, 1),
                f"{case}_poster_yavg_delta": round(abs(y_proxy - y_orig), 1),
                f"{case}_planted_values_found": found, f"{case}_exif_segments": exif,
            })
            print(case, {k: v for k, v in metrics.items() if k.startswith(case)})
    result = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-thumbnail-from-proxy",
        "started_at": started, "ended_at": now(),
        "result": "pass" if leaks == 0 else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(args.seconds), "codec": "h264+hevc", "vfr": False, "hdr": True},
        "metrics": {**metrics, "leaks_total": leaks,
                    "ffmpeg_version": ffmpeg.version()},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    return 0 if leaks == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
