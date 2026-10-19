"""تكامل حقيقي مع Redis وMinIO: الدفق ← العامل ← خادم داخلي بديل (HTTP حقيقي) ← حاوية المشتقات.

يعمل حين تُضبط MEDIA_IT_REDIS_URL وMEDIA_IT_S3_ENDPOINT وMEDIA_IT_S3_ACCESS_KEY وMEDIA_IT_S3_SECRET_KEY (وظيفة
`media` في CI تشغّل الحاويتين)، ويُتجاوز غير ذلك.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import synth
from media_worker.api import InternalApi
from media_worker.jobs import Buckets, Jobs, proxy_key
from media_worker.probe import probe
from media_worker.service import DEAD, GROUP, STREAM, Service
from media_worker.storage import DIRECT, S3Storage, sign_v4

ENV = {k: os.environ.get(f"MEDIA_IT_{k}") for k in ("REDIS_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY")}
pytestmark = pytest.mark.skipif(not all(ENV.values()), reason="needs Redis and MinIO (MEDIA_IT_*)")
if os.environ.get("MEDIA_IT_REQUIRED") and not all(ENV.values()):
    raise RuntimeError("MEDIA_IT_REQUIRED is set but MEDIA_IT_* is incomplete")  # CI لا يتجاوز التكامل بصمت
TOKEN = "t" * 40


def _s3(method: str, path: str, body: bytes = b"") -> None:
    url = f"{ENV['S3_ENDPOINT']}{path}"
    headers = sign_v4(method, url, {}, hashlib.sha256(body).hexdigest(), ENV["S3_ACCESS_KEY"],
                      ENV["S3_SECRET_KEY"], "us-east-1", datetime.now(timezone.utc))
    try:
        DIRECT.open(urllib.request.Request(url, data=body or None, method=method, headers=headers), timeout=30)
    except urllib.error.HTTPError as err:
        if err.code != 409:  # الحاوية موجودة
            raise


class FakeServer:
    """يطبّق شكل نقاط ADR 0006 بحالة في الذاكرة؛ يرفض أي طلب بلا الرمز الصحيح."""

    def __init__(self, session: dict, fail_with: int | None = None):
        self.session, self.fail_with = session, fail_with
        self.calls: list[tuple[str, str, dict | None]] = []
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
                outer.calls.append((method, self.path, body))
                if outer.fail_with:
                    return self._reply(outer.fail_with)
                s = outer.session
                if method == "GET":
                    return self._reply(200, s)
                if self.path.endswith("/verification"):
                    if s["state"] == "completed":
                        s["state"] = "verified" if body["result"] == "verified" else "failed"
                        s["file_id"] = str(uuid.uuid4())
                    return self._reply(200, {"state": s["state"], "file_id": s.get("file_id"),
                                             "receipt_number": None, "failure_reason": None})
                s["material_has_proxy"] = True
                return self._reply(200, {})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def env(tmp_path: Path):
    import redis

    r = redis.Redis.from_url(ENV["REDIS_URL"], decode_responses=True)
    r.delete(STREAM, DEAD)
    suffix = uuid.uuid4().hex[:8]
    buckets = Buckets(uploads=f"it-uploads-{suffix}", derived=f"it-media-{suffix}")
    for b in (buckets.uploads, buckets.derived):
        _s3("PUT", f"/{b}")
    storage = S3Storage(ENV["S3_ENDPOINT"], "us-east-1", ENV["S3_ACCESS_KEY"], ENV["S3_SECRET_KEY"], buckets.derived)
    yield r, storage, buckets
    r.delete(STREAM, DEAD)


def _publish(r, type_: str, session_id: str, material_id: str) -> None:
    event = {"id": "1", "type": type_, "aggregate_type": "upload", "aggregate_id": session_id,
             "payload": {"material_id": material_id, "upload_session_id": session_id, "kind": "original"}}
    r.xadd(STREAM, {"event_id": "1", "event": json.dumps(event)})


def test_end_to_end_verify_and_proxy(env, tmp_path: Path):
    r, storage, buckets = env
    clip = synth(tmp_path / "src.mp4", seconds=3, size="1280x720", start_offset=4).read_bytes()
    sid, mid, key = str(uuid.uuid4()), str(uuid.uuid4()), "tus/abc123"
    _s3("PUT", f"/{buckets.uploads}/{key}", clip)
    server = FakeServer({"material_id": mid, "kind": "original", "state": "completed", "size_bytes": len(clip),
                         "storage_key": key, "proxy_mode": None, "material_has_proxy": False})
    try:
        svc = Service(r, Jobs(InternalApi(server.url, TOKEN), storage, buckets, tmp_path), "it", block_ms=500)
        svc.ensure_group()
        _publish(r, "upload.original_received", sid, mid)
        assert svc.run_once() == 1
        verification = next(b for m, p, b in server.calls if p.endswith("/verification"))
        assert verification["result"] == "verified"
        assert verification["sha256"] == hashlib.sha256(clip).hexdigest()
        assert verification["technical"]["start_pts_us"] == 4_000_000

        derivative = next(b for m, p, b in server.calls if p.endswith("/derivatives"))
        file_id = server.session["file_id"]
        assert derivative["storage_key"] == proxy_key(mid, file_id)
        out = tmp_path / "p.mp4"
        out.write_bytes(b"".join(storage.read(buckets.derived, derivative["storage_key"])))
        assert hashlib.sha256(out.read_bytes()).hexdigest() == derivative["sha256"]
        assert probe(out).start_pts_us == 4_000_000 and probe(out).height == 480
        # الأصل لم يتغير، ولا شيء معلّق، وإعادة التسليم لا تكرر شيئًا
        assert b"".join(storage.read(buckets.uploads, key)) == clip
        assert r.xpending(STREAM, GROUP)["pending"] == 0
        _publish(r, "upload.original_received", sid, mid)
        calls = len(server.calls)
        assert svc.run_once() == 1
        assert len(server.calls) == calls + 1  # GET فقط
    finally:
        server.close()


def test_transient_failures_end_in_dead_letter(env, tmp_path: Path):
    r, storage, buckets = env
    server = FakeServer({}, fail_with=503)
    try:
        svc = Service(r, Jobs(InternalApi(server.url, TOKEN), storage, buckets, tmp_path), "it", block_ms=200,
                      claim_idle_ms=0, max_deliveries=2)
        svc.ensure_group()
        _publish(r, "upload.original_received", str(uuid.uuid4()), str(uuid.uuid4()))
        for _ in range(4):
            svc.run_once()
        assert r.xlen(DEAD) == 1
        assert r.xpending(STREAM, GROUP)["pending"] == 0
        assert len(server.calls) == 2  # محاولتان ثم نقل دون استدعاء ثالث
    finally:
        server.close()
