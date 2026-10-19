"""مهمة العامل لكل حدث `upload.original_received` / `upload.proxy_received`، متساوية الأثر عند التكرار
(التسليم «مرة على الأقل»):

1. تنزيل تدفقي للكائن إلى مجلد المهمة مع SHA-256 والبصمة الرخيصة في القراءة نفسها.
2. البيانات الفنية (ffprobe)؛ الفشل = `invalid_file`.
3. إبلاغ الخادم (`POST …/verification`). الخادم يقرر الحجم ومطابقة بصمة العميل ويكتب النتيجة.
4. لأصل مرئي تحقق ولا نسخة خفيفة له من الهاتف: نسخة 480p من الملف المنزَّل نفسه، تُرفع إلى حاوية المشتقات تحت
   `derived/<material_id>/<file_id>/` ويُبلَّغ بها (`POST …/derivatives`).

إعادة التسليم بعد تحقق سابق (فشلت الخطوة 4): الجلسة `verified` والأصل بلا نسخة، فيُعاد البلاغ نفسه، والخادم يعيد
النتيجة المسجلة ومعها `file_id`، ثم تُكمَل الخطوة 4. الأصل يُقرأ فقط، ومجلد المهمة يُحذف في كل الأحوال.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .api import InternalApi, Session
from .hashing import digest_file, digest_stream
from .probe import InvalidMediaError, Probe, probe
from .proxy import make_proxy
from .storage import DERIVED_PREFIX, ObjectMissing

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
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/proxy-480p.mp4"


def _download(storage: Storage, bucket: str, key: str, dst: Path):
    """يكتب الكائن إلى ملف محلي ويحسب البصمة في القراءة نفسها."""
    with open(dst, "wb") as fh:
        def tee() -> Iterator[bytes]:
            for chunk in storage.read(bucket, key):
                fh.write(chunk)
                yield chunk
        return digest_stream(tee())


def _wants_proxy(session: Session) -> bool:
    return session.kind == "original" and not session.material_has_proxy


class Jobs:
    def __init__(self, api: InternalApi, storage: Storage, buckets: Buckets, scratch: Path | None = None):
        self.api = api
        self.storage = storage
        self.buckets = buckets
        self.scratch = scratch

    def handle(self, event: dict) -> str:
        """يعيد وصفًا قصيرًا لما حدث (للسجل والاختبارات)."""
        session_id = (event.get("payload") or {}).get("upload_session_id")
        if event.get("type") not in VERIFY_EVENTS or not session_id:
            return "ignored"
        return self.process(session_id)

    def process(self, session_id: str) -> str:
        session = self.api.get_session(session_id)
        resume = session.state == "verified" and _wants_proxy(session)
        if session.state != "completed" and not resume:
            return f"skip:{session.state}"
        with tempfile.TemporaryDirectory(dir=self.scratch, prefix="job-") as tmp:
            local = Path(tmp) / "source"
            try:
                if not session.storage_key:
                    raise ObjectMissing("no storage key")
                digest = _download(self.storage, self.buckets.uploads, session.storage_key, local)
            except ObjectMissing:
                if resume:
                    return "skip:missing-after-verify"
                self.api.report_verification(session_id, {"result": "storage_error"})
                return "storage_error"

            # الفشل يُبلَّغ بلا بصمة ولا بيانات فنية: لا شيء منه يُخزَّن
            if digest.size_bytes != session.size_bytes:
                self.api.report_verification(session_id, {"result": "invalid_file"})
                return "invalid_file"
            try:
                info: Probe = probe(local)
            except InvalidMediaError:
                self.api.report_verification(session_id, {"result": "invalid_file"})
                return "invalid_file"

            result = self.api.report_verification(session_id, {
                "result": "verified", "sha256": digest.sha256, **digest.fingerprint(), "technical": info.to_dict(),
            })
            if result.get("state") != "verified":
                return result.get("failure_reason") or "failed"
            if not _wants_proxy(session) or info.video_codec is None:
                return "verified"
            return self._proxy(session, result["file_id"], local, info)

    def _proxy(self, session: Session, file_id: str, local: Path, info: Probe) -> str:
        out = local.with_name("proxy-480p.mp4")
        made = make_proxy(local, out, info)
        d = digest_file(out)
        key = proxy_key(session.material_id, file_id)
        self.storage.put_file(self.buckets.derived, key, out, d.sha256, "video/mp4")
        self.api.add_derivative(file_id, {
            "kind": "proxy", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
            "technical": made.to_dict(),
        })
        return "verified+proxy"
