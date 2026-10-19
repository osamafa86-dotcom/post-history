"""مهمتا العامل لكل حدث، وكلتاهما متساوية الأثر عند التكرار (التسليم «مرة على الأقل»):

- `upload.original_received` / `upload.proxy_received` ← التحقق: تنزيل تدفقي مع SHA-256 والبصمة الرخيصة،
  ثم البيانات الفنية، ثم إبلاغ الخادم. جلسة لم تعد `completed` تُتجاوز.
- `upload.verified` لأصل ← النسخة الخفيفة 480p إن لم تصل نسخة من الهاتف، تُرفع إلى حاوية المشتقات ويُبلَّغ بها.

الأصل يُقرأ فقط. الملفات المحلية في مجلد مؤقت لكل مهمة يُحذف في كل الأحوال.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .api import InternalApi
from .hashing import digest_file, digest_stream
from .probe import InvalidMediaError, Probe, probe
from .proxy import make_proxy
from .storage import ObjectMissing

log = logging.getLogger("media_worker.jobs")

VERIFY_EVENTS = {"upload.original_received", "upload.proxy_received"}


class Storage(Protocol):
    def read(self, bucket: str, key: str) -> Iterable[bytes]: ...
    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None: ...


@dataclass(frozen=True)
class Buckets:
    uploads: str
    derived: str


def proxy_key(material_id: str, file_id: str) -> str:
    return f"proxies/{material_id}/{file_id}/proxy-480p.mp4"


def _download(storage: Storage, bucket: str, key: str, dst: Path):
    """يكتب الكائن إلى ملف محلي ويحسب البصمة في القراءة نفسها."""
    with open(dst, "wb") as fh:
        def tee() -> Iterator[bytes]:
            for chunk in storage.read(bucket, key):
                fh.write(chunk)
                yield chunk
        return digest_stream(tee())


class Jobs:
    def __init__(self, api: InternalApi, storage: Storage, buckets: Buckets, scratch: Path | None = None):
        self.api = api
        self.storage = storage
        self.buckets = buckets
        self.scratch = scratch

    def handle(self, event: dict) -> str:
        """يعيد وصفًا قصيرًا لما حدث (للسجل والاختبارات)."""
        kind = event.get("type")
        payload = event.get("payload") or {}
        session_id = payload.get("upload_session_id")
        if not session_id:
            return "ignored"
        if kind in VERIFY_EVENTS:
            return self.verify(session_id)
        if kind == "upload.verified" and payload.get("kind") == "original":
            return self.proxy(session_id)
        return "ignored"

    def verify(self, session_id: str) -> str:
        session = self.api.get_session(session_id)
        if session.state != "completed":
            return f"skip:{session.state}"
        with tempfile.TemporaryDirectory(dir=self.scratch, prefix="verify-") as tmp:
            local = Path(tmp) / "source"
            try:
                if not session.storage_key:
                    raise ObjectMissing("no storage key")
                digest = _download(self.storage, self.buckets.uploads, session.storage_key, local)
            except ObjectMissing:
                self.api.report_verification(session_id, {"result": "storage_error"})
                return "storage_error"

            body = {"result": "verified", "sha256": digest.sha256, **digest.fingerprint()}
            if digest.size_bytes != session.size_bytes:
                body["result"] = "invalid_file"
            else:
                try:
                    body["technical"] = probe(local).to_dict()
                except InvalidMediaError:
                    body["result"] = "invalid_file"
            self.api.report_verification(session_id, body)
            return body["result"]

    def proxy(self, session_id: str) -> str:
        session = self.api.get_session(session_id)
        if session.kind != "original" or session.state != "verified" or not session.file_id:
            return "skip:not-verified-original"
        if session.material_has_proxy:
            return "skip:has-proxy"
        with tempfile.TemporaryDirectory(dir=self.scratch, prefix="proxy-") as tmp:
            local, out = Path(tmp) / "source", Path(tmp) / "proxy-480p.mp4"
            _download(self.storage, self.buckets.uploads, session.storage_key or "", local)
            source: Probe = probe(local)
            if source.video_codec is None:
                return "skip:no-video"
            result = make_proxy(local, out, source)
            d = digest_file(out)
            key = proxy_key(session.material_id, session.file_id)
            self.storage.put_file(self.buckets.derived, key, out, d.sha256, "video/mp4")
            self.api.add_derivative(session.file_id, {
                "kind": "proxy", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
                "technical": result.to_dict(),
            })
            return "proxy"
