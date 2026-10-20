"""قياس التنزيل الكامل إلى القرص قبل المعالجة (ADR 0006): الزمن وذروة الذاكرة لملف 4K اصطناعي.

الملف يُولَّد محليًا ويُرفع إلى MinIO، ثم ينزّله العامل بمسار المهمة نفسه (`jobs._download`: قراءة تدفقية من S3
مع SHA-256 والبصمة الرخيصة) في عملية فرعية جديدة، فذروة الذاكرة (`ru_maxrss`) هي ذروة التنزيل وحده. المخرج بمخطط
contracts/schemas/measurement.json.

    MEDIA_IT_S3_ENDPOINT=http://minio:9000 MEDIA_IT_S3_ACCESS_KEY=… MEDIA_IT_S3_SECRET_KEY=… \\
        python bench/download_bench.py --out /results/<date>-download-4k.json [--seconds 120 --mbps 50]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.storage import DIRECT, sign_v4

CHILD = r"""
import json, resource, sys, tempfile, time
from pathlib import Path
from media_worker.jobs import _download
from media_worker.probe import probe
from media_worker.storage import S3Storage
endpoint, access, secret, bucket, key, scratch = sys.argv[1:7]
storage = S3Storage(endpoint, "us-east-1", access, secret, writable_bucket="none")
with tempfile.TemporaryDirectory(dir=scratch, prefix="job-") as tmp:
    local = Path(tmp) / "source"
    t = time.perf_counter()
    digest = _download(storage, bucket, key, local)
    download_s = time.perf_counter() - t
    rss_after_download = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    t = time.perf_counter()
    info = probe(local)
    probe_s = time.perf_counter() - t
print(json.dumps({"download_s": download_s, "peak_rss_kb_download": rss_after_download,
                  "probe_s": probe_s, "size_bytes": digest.size_bytes, "sha256": digest.sha256,
                  "width": info.width, "height": info.height, "duration_ms": info.duration_ms}))
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def s3(method: str, endpoint: str, path: str, access: str, secret: str, body=None, payload_hash=None,
       size: int | None = None) -> None:
    url = f"{endpoint}{path}"
    extra = {"content-length": str(size)} if size is not None else {}
    headers = sign_v4(method, url, extra, payload_hash or hashlib.sha256(b"").hexdigest(), access, secret,
                      "us-east-1", datetime.now(timezone.utc))
    try:
        with DIRECT.open(urllib.request.Request(url, data=body, method=method, headers=headers), timeout=600):
            pass
    except urllib.error.HTTPError as err:
        if not (method == "PUT" and err.code == 409):  # الحاوية موجودة
            raise


def make_source(path: Path, seconds: int, mbps: int) -> None:
    ffmpeg.run([
        ffmpeg.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=3840x2160:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
        "-vf", "noise=alls=10:allf=t", "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", f"{mbps}M", "-maxrate", f"{mbps}M", "-bufsize", f"{2 * mbps}M", "-g", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", str(path),
    ], timeout_s=seconds * 60)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--mbps", type=int, default=50)
    args = ap.parse_args()
    endpoint, access, secret = (os.environ[f"MEDIA_IT_S3_{k}"] for k in ("ENDPOINT", "ACCESS_KEY", "SECRET_KEY"))

    started = now()
    bucket = f"bench-{uuid.uuid4().hex[:8]}"
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "source-4k.mp4"
        t = time.perf_counter()
        make_source(src, args.seconds, args.mbps)
        generate_s = time.perf_counter() - t
        sha = hashlib.sha256()
        with open(src, "rb") as fh:
            while chunk := fh.read(8 << 20):
                sha.update(chunk)
        s3("PUT", endpoint, f"/{bucket}", access, secret)
        with open(src, "rb") as fh:
            s3("PUT", endpoint, f"/{bucket}/tus/source", access, secret, body=fh, payload_hash=sha.hexdigest(),
               size=src.stat().st_size)
        src.unlink()  # التنزيل يكتب نسخة جديدة؛ لا يبقى الأصل المحلي في ذاكرة الصفحات

        scratch = Path(tmp) / "scratch"
        scratch.mkdir()
        env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": os.environ.get("PYTHONPATH", "")}
        out = subprocess.run([sys.executable, "-c", CHILD, endpoint, access, secret, bucket, "tus/source",
                              str(scratch)], capture_output=True, check=True, env=env, timeout=3600)
        r = json.loads(out.stdout)
    ended = now()

    assert r["sha256"] == sha.hexdigest()
    size_mb = r["size_bytes"] / 1e6
    result = {
        "schema_version": 1,
        "tool": "other",
        "role": "media",
        "test_name": "media-download-to-disk-4k",
        "started_at": started,
        "ended_at": ended,
        # بلا معيار قبول في الخطة لهذا البند: النتيجة معلوماتية لتحديد حجم /scratch وذاكرة الحاوية
        "result": "info",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"},
        "upload_path": "n/a",
        "file": {"size_bytes": r["size_bytes"], "duration_s": r["duration_ms"] / 1000,
                 "bitrate_kbps": round(r["size_bytes"] * 8 / (r["duration_ms"] / 1000) / 1000),
                 "codec": "h264", "vfr": False, "hdr": False},
        "metrics": {
            "download_s": round(r["download_s"], 3),
            "download_mb_per_s": round(size_mb / r["download_s"], 1),
            "peak_rss_mb_download_process": round(r["peak_rss_kb_download"] / 1024, 1),
            "probe_s": round(r["probe_s"], 3),
            "scratch_bytes_needed": r["size_bytes"],
            "resolution": f"{r['width']}x{r['height']}",
            "source_generate_s": round(generate_s, 1),
            "sha256_matches_upload": True,
            "ffmpeg_version": ffmpeg.version(),
        },
        "notes": "",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
