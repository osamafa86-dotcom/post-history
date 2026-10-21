"""قياس حزمة التصدير (التذكرة 6): زمن إنتاجها وحجمها لمقطع 4K اصطناعي مدته دقيقتان.

يقيس مسار المهمة نفسه بعد التنزيل: البيانات الفنية، النسخة الخفيفة 480p، ثم `build_package` (نسخة منزوعة البيانات
الوصفية بنسخ التيارات والأرشيف) وبصمة الأرشيف كاملًا (ما يُرسل مع تسجيل المشتق). لا ملف حقيقي ولا اتصال خارجي. المخرج بمخطط contracts/schemas/measurement.json.

    python bench/export_bench.py --out /results/<date>-export-4k.json [--seconds 120 --mbps 50]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from download_bench import make_source  # noqa: E402

from media_worker import ffmpeg  # noqa: E402
from media_worker.export import build_package  # noqa: E402
from media_worker.hashing import digest_file  # noqa: E402
from media_worker.probe import probe  # noqa: E402
from media_worker.proxy import make_proxy  # noqa: E402


def packets(path: Path) -> bytes:
    return hashlib.sha256(ffmpeg.run([ffmpeg.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
                                      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "framemd5", "-"],
                                     timeout_s=600)).digest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--mbps", type=int, default=50)
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        src = d / "source.mov"
        t = time.perf_counter()
        make_source(src, args.seconds, args.mbps)
        generate_s = time.perf_counter() - t
        started = now()
        t0 = time.perf_counter()
        info = probe(src)
        digest = digest_file(src)
        t1 = time.perf_counter()
        make_proxy(src, d / "proxy-480p.mp4", info)
        t2 = time.perf_counter()
        out = d / "export.zip"
        build_package(out, original=src, info=info, material_id="m", file_id="f", sha256=digest.sha256,
                      size_bytes=digest.size_bytes, proxy=d / "proxy-480p.mp4")
        t3 = time.perf_counter()
        zd = digest_file(out)
        t4 = time.perf_counter()
        ended = now()
        with zipfile.ZipFile(out) as zf:
            name = zf.namelist()[0]
            zf.extract(name, d / "check")
        clip_is_copy = packets(d / "check" / name) == packets(src)
        size = out.stat().st_size
        result = {
            "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-export-package-4k",
            "started_at": started, "ended_at": ended, "result": "info",
            "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
            "file": {"size_bytes": digest.size_bytes, "duration_s": info.duration_ms / 1000,
                     "bitrate_kbps": round(digest.size_bytes * 8 / info.duration_ms), "codec": info.video_codec,
                     "vfr": info.vfr, "hdr": info.hdr},
            "metrics": {
                "package_total_s": round(t4 - t0, 2), "probe_and_hash_s": round(t1 - t0, 2),
                "proxy_480p_s": round(t2 - t1, 2), "build_package_s": round(t3 - t2, 2),
                "archive_sha256_s": round(t4 - t3, 2), "package_size_bytes": size,
                "package_overhead_bytes": size - digest.size_bytes, "clip_packets_match_original": clip_is_copy,
                "resolution": f"{info.width}x{info.height}", "source_generate_s": round(generate_s, 1),
                # ذروة القرص: الأصل والنسخة المنزوعة (قبل حذفها) والأرشيف والنسخة الخفيفة
                "scratch_bytes_needed": 2 * digest.size_bytes + size + (d / "proxy-480p.mp4").stat().st_size,
                "ffmpeg_version": ffmpeg.version(),
            },
        }
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["metrics"]))


if __name__ == "__main__":
    main()
