"""هدف الخدمة «جاهزية نسخة المعاينة لمقطع مدته دقيقة خلال دقيقتين»، مقيسًا طرفًا لطرف على خط العامل الحقيقي.

الزمن من نشر الحدث `upload.original_received` في Redis Stream إلى وصول تسجيل `kind=proxy` إلى الخادم الداخلي.
بينهما ما يجري في الإنتاج كله: قراءة الدفق، والتنزيل من MinIO مع SHA-256، وffprobe، وبلاغ التحقق، وموجة الصوت،
والمصغّرات، ثم ترميز `proxy-480p.mp4` ورفعه. الخادم الداخلي بديل HTTP محلي بشكل نقاط ADR 0006 (زمنه ميلي ثوانٍ)،
والمقاطع اصطناعية تحاكي ملفات الهواتف: H.264 بدقة 1080p و4K، وHEVC 10 بت HLG.

    MEDIA_IT_REDIS_URL=… MEDIA_IT_S3_ENDPOINT=… MEDIA_IT_S3_ACCESS_KEY=… MEDIA_IT_S3_SECRET_KEY=… \\
        python bench/preview_slo.py [--profiles 1080p-h264,4k-h264,1080p-hlg] [--runs 5] [--max-s 120] [--out …]

الخروج 1 إن تجاوز أي تشغيل الحد. المخرج بمخطط contracts/schemas/measurement.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import redis

sys.path.insert(0, str(Path(__file__).parent))
from download_bench import s3  # noqa: E402

from media_worker import ffmpeg  # noqa: E402
from media_worker.api import InternalApi  # noqa: E402
from media_worker.jobs import Buckets, Jobs  # noqa: E402
from media_worker.service import STREAM, Service  # noqa: E402
from media_worker.storage import S3Storage  # noqa: E402

TOKEN = "slo-" + "t" * 36
NOISE = ["-vf", "noise=alls=8:allf=t"]
PROFILES = {
    # (حجم، مرمّز وإعداداته)؛ المعدلات قريبة مما تسجّله الهواتف
    "1080p-h264": ("1920x1080", [*NOISE, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "17M",
                                 "-g", "30", "-pix_fmt", "yuv420p"]),
    "4k-h264": ("3840x2160", [*NOISE, "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "50M",
                              "-g", "30", "-pix_fmt", "yuv420p"]),
    "1080p-hlg": ("1920x1080", ["-vf", "noise=alls=8:allf=t,format=yuv420p10le", "-c:v", "libx265",
                                "-preset", "ultrafast", "-b:v", "12M", "-x265-params",
                                "log-level=error:pools=none:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
                                "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
                                "-tag:v", "hvc1"]),
}


def make_clip(path: Path, profile: str, seconds: int) -> None:
    size, video = PROFILES[profile]
    ffmpeg.run([ffmpeg.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
                "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
                *video, "-c:a", "aac", "-b:a", "128k", str(path)], timeout_s=seconds * 60)


class Server:
    """نقاط ADR 0006 بحالة في الذاكرة؛ يسجّل لحظة وصول تسجيل النسخة الخفيفة لكل جلسة."""

    def __init__(self) -> None:
        self.sessions: dict[str, dict] = {}
        self.proxy_at: dict[str, float] = {}
        self.verified_at: dict[str, float] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, code: int, body: dict | None = None):
                raw = json.dumps(body or {}).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method: str):
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self._reply(404)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                parts = self.path.strip("/").split("/")  # internal/media/<sessions|files>/<id>[/...]
                if parts[2] == "sessions":
                    if parts[3] not in outer.sessions:
                        return self._reply(410)  # حدث قديم في الدفق من تشغيل سابق: يُنقل إلى media:dead
                    s = outer.sessions[parts[3]]
                    if method == "GET":
                        return self._reply(200, s)
                    if s["state"] == "completed":
                        s["state"] = "verified" if body["result"] == "verified" else "failed"
                        s["file_id"] = str(uuid.uuid4())
                        outer.verified_at[parts[3]] = time.perf_counter()
                    return self._reply(200, {"state": s["state"], "file_id": s.get("file_id"),
                                             "receipt_number": None, "failure_reason": None})
                if body["kind"] == "proxy":
                    sid = next(k for k, v in outer.sessions.items() if v.get("file_id") == parts[3])
                    outer.proxy_at[sid] = time.perf_counter()
                return self._reply(200, {"file_id": str(uuid.uuid4())})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", default="1080p-h264,4k-h264,1080p-hlg")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--max-s", type=float, default=120.0)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    e = os.environ
    endpoint, access, secret = e["MEDIA_IT_S3_ENDPOINT"], e["MEDIA_IT_S3_ACCESS_KEY"], e["MEDIA_IT_S3_SECRET_KEY"]
    buckets = Buckets(uploads="slo-uploads", derived="slo-media")
    for b in (buckets.uploads, buckets.derived):
        s3("PUT", endpoint, f"/{b}", access, secret)
    r = redis.Redis.from_url(e["MEDIA_IT_REDIS_URL"], decode_responses=True)
    server = Server()
    storage = S3Storage(endpoint, "us-east-1", access, secret, buckets.derived)
    metrics: dict[str, object] = {}
    worst = 0.0
    started = now()
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp) / "scratch"
        scratch.mkdir()
        svc = Service(r, Jobs(InternalApi(server.url, TOKEN), storage, buckets, scratch), "slo", block_ms=500)
        svc.ensure_group()
        for profile in args.profiles.split(","):
            clip = Path(tmp) / f"{profile}.mov"
            make_clip(clip, profile, args.seconds)
            data = clip.read_bytes()
            key = f"tus/slo-{profile}"
            s3("PUT", endpoint, f"/{buckets.uploads}/{key}", access, secret, data, hashlib.sha256(data).hexdigest())
            clip.unlink()
            totals, verifies = [], []
            for _ in range(args.runs):
                sid, mid = str(uuid.uuid4()), str(uuid.uuid4())
                server.sessions[sid] = {"material_id": mid, "kind": "original", "state": "completed",
                                        "size_bytes": len(data), "storage_key": key, "proxy_mode": None,
                                        "material_has_proxy": False}
                t0 = time.perf_counter()
                event = {"id": sid, "type": "upload.original_received", "aggregate_type": "upload",
                         "aggregate_id": sid,
                         "payload": {"material_id": mid, "upload_session_id": sid, "kind": "original"}}
                r.xadd(STREAM, {"event_id": sid, "event": json.dumps(event)})
                deadline = t0 + 3 * args.max_s
                while sid not in server.proxy_at and time.perf_counter() < deadline:
                    svc.run_once()
                if sid not in server.proxy_at:
                    raise RuntimeError(f"{profile}: no proxy registered")
                totals.append(server.proxy_at[sid] - t0)
                verifies.append(server.verified_at[sid] - t0)
            totals.sort()
            worst = max(worst, totals[-1])
            metrics.update({
                f"{profile}_p50_s": round(statistics.median(totals), 2),
                f"{profile}_p95_s": round(totals[min(len(totals) - 1, round(0.95 * (len(totals) - 1)))], 2),
                f"{profile}_max_s": round(totals[-1], 2),
                f"{profile}_verified_p50_s": round(statistics.median(verifies), 2),
                f"{profile}_size_bytes": len(data),
            })
    ok = worst <= args.max_s
    result = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-preview-ready-1min",
        "started_at": started, "ended_at": now(), "result": "pass" if ok else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"size_bytes": max(v for k, v in metrics.items() if k.endswith("_size_bytes")),
                 "duration_s": float(args.seconds), "codec": "h264+hevc", "vfr": False,
                 "hdr": "1080p-hlg" in args.profiles},
        "metrics": {**metrics, "runs_per_profile": args.runs, "limit_s": args.max_s,
                    "ffmpeg_version": ffmpeg.version()},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
