"""قياس زمن معالجة ملف دقيقتين 1080p: البيانات الفنية + البصمة + النسخة الخفيفة.

الملف اصطناعي (testsrc2 مع ضجيج حتى يقارب معدل بت تسجيل الهاتف) يُولَّد في مجلد مؤقت ويُحذف بعد القياس.
المخرج ملف بمخطط contracts/schemas/measurement.json.

    python bench/run_bench.py --out /results/2026-10-19-ingest-2min-1080p.json [--seconds 120]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.hashing import digest_file
from media_worker.probe import probe
from media_worker.proxy import make_proxy


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def make_source(path: Path, seconds: int) -> None:
    ffmpeg.run([
        ffmpeg.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
        "-vf", "noise=alls=12:allf=t", "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", "16M", "-maxrate", "16M", "-bufsize", "32M", "-g", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-output_ts_offset", "3.5", str(path),
    ], timeout_s=seconds * 20)


def timed(fn):
    t = time.perf_counter()
    value = fn()
    return value, round(time.perf_counter() - t, 3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seconds", type=int, default=120)
    args = ap.parse_args()

    started = now()
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "source.mp4", Path(tmp) / "proxy.mp4"
        make_source(src, args.seconds)
        info, probe_s = timed(lambda: probe(src))
        digest, digest_s = timed(lambda: digest_file(src))
        out, proxy_s = timed(lambda: make_proxy(src, dst, info))
        proxy_size = dst.stat().st_size
    ended = now()

    total = round(probe_s + digest_s + proxy_s, 3)
    duration_s = info.duration_ms / 1000
    result = {
        "schema_version": 1,
        "tool": "other",
        "role": "media",
        "test_name": "media-ingest-2min-1080p",
        "started_at": started,
        "ended_at": ended,
        "result": "pass" if total < duration_s and out.start_pts_us == info.start_pts_us else "fail",
        "device": {
            "platform": "server",
            "model": f"{cpu_model()} x{os.cpu_count()} vCPU",
            "os_version": platform.release(),
        },
        "upload_path": "n/a",
        "file": {
            "size_bytes": digest.size_bytes,
            "duration_s": duration_s,
            "bitrate_kbps": round(digest.size_bytes * 8 / duration_s / 1000),
            "codec": info.video_codec,
            "vfr": info.vfr,
            "hdr": info.hdr,
        },
        "metrics": {
            "probe_s": probe_s,
            "sha256_and_fingerprint_s": digest_s,
            "sha256_mb_per_s": round(digest.size_bytes / 1e6 / digest_s, 1),
            "proxy_480p_s": proxy_s,
            "total_s": total,
            "realtime_factor": round(duration_s / total, 2),
            "proxy_size_bytes": proxy_size,
            "proxy_bitrate_kbps": round(proxy_size * 8 / duration_s / 1000),
            "start_pts_us_source": info.start_pts_us,
            "start_pts_us_proxy": out.start_pts_us,
            "ffmpeg_version": ffmpeg.version(),
            "acceptance": "total_s < duration_s and proxy start_pts == source start_pts",
        },
        "notes": "",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
