"""مهمة العامل لكل حدث `upload.original_received` / `upload.proxy_received`، متساوية الأثر عند التكرار
(التسليم «مرة على الأقل»):

1. تنزيل تدفقي للكائن إلى مجلد المهمة مع SHA-256 والبصمة الرخيصة في القراءة نفسها.
2. البيانات الفنية (ffprobe)؛ الفشل = `invalid_file`.
3. إبلاغ الخادم (`POST …/verification`). الخادم يقرر الحجم ومطابقة بصمة العميل ويكتب النتيجة.
4. لأصل مرئي تحقق: المصغّرات (إطار ملصق وصفيحة اتصال) في `derived/<material_id>/<file_id>/`. خطوة غير مانعة:
   فشلها يُسجَّل ولا يعيد الحدث ولا يمنع النسخة الخفيفة.
5. لكل أصل مرئي تحقق، حتى حين أرسل الهاتف نسخته الخفيفة: نسخة الخادم 480p من الملف المنزَّل نفسه، تُرفع إلى حاوية
   المشتقات تحت `derived/<material_id>/<file_id>/` ويُبلَّغ بها (`POST …/derivatives`). العمّال اللاحقون (التفريغ)
   يقرؤونها هي لا نسخة الهاتف.
6. للملاحظة الصوتية المتحققة: `audio-16k.m4a` (AAC أحادية 16 kHz بلا وسوم) مشتقًا `kind=audio`، خطوة مانعة كالخطوة 5.

إعادة التسليم بعد تحقق سابق: الجلسة `verified`، فيُعاد البلاغ نفسه، والخادم يعيد النتيجة المسجلة ومعها `file_id`.
إن كانت نسخة الخادم مرفوعة يُعاد تسجيلها كما هي (الخادم يقبل التكرار المطابق) ولا تُرمَّز من جديد فلا تتغير بصمتها،
وإلا تُكمَل الخطوة 5. الأصل يُقرأ فقط، ومجلد المهمة يُحذف في كل الأحوال.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .api import ApiConflict, ApiRejected, InternalApi, Session
from .hashing import Digest, digest_file, digest_stream
from .probe import InvalidMediaError, Probe, probe
from .audio import make_speech_audio
from .export import build_package
from .watermark import make_watermarked_preview
from .proxy import make_proxy
from .hls import make_hls
from .phash import video_phash
from .thumbnails import contact_sheet, poster
from .waveform import write_waveform
from .storage import DERIVED_PREFIX, ObjectMissing

log = logging.getLogger("media_worker.jobs")

VERIFY_EVENTS = {"upload.original_received", "upload.proxy_received"}


class Storage(Protocol):
    def read(self, bucket: str, key: str) -> Iterable[bytes]: ...
    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None: ...
    def head(self, bucket: str, key: str) -> int: ...


@dataclass(frozen=True)
class Buckets:
    uploads: str
    derived: str


def proxy_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/proxy-480p.mp4"


def poster_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/poster.jpg"


def contact_sheet_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/contact-sheet.jpg"


def waveform_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/waveform.json"


def speech_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/audio-16k.m4a"


def store_preview_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/preview-watermarked.mp4"


def export_key(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/export.zip"


def hls_prefix(material_id: str, file_id: str) -> str:
    # تحت مساحة ملف المصدر: الخادم يقبل المشتق في derived/<material_id>/<file_id>/ وحدها (ADR 0006)
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/hls/"


def _download(storage: Storage, bucket: str, key: str, dst: Path):
    """يكتب الكائن إلى ملف محلي ويحسب البصمة في القراءة نفسها."""
    with open(dst, "wb") as fh:
        def tee() -> Iterator[bytes]:
            for chunk in storage.read(bucket, key):
                fh.write(chunk)
                yield chunk
        return digest_stream(tee())


class Jobs:
    def __init__(self, api: InternalApi, storage: Storage, buckets: Buckets, scratch: Path | None = None,
                 enable_hls: bool = False, enable_phash: bool = False, enable_export: bool = False,
                 enable_store_preview: bool = False, watermark_key: bytes = b""):
        # الأعلام مطفأة إلى أن يقبل العقد نوع hls (#58) وحقل البصمة الإدراكية ونوع export؛ ومعاينة المتجر حتى نقطة
        # مصدر الأصل في #178
        self.enable_store_preview = enable_store_preview
        self.watermark_key = watermark_key
        self.enable_export = enable_export
        self.enable_hls = enable_hls
        self.enable_phash = enable_phash
        self.api = api
        self.storage = storage
        self.buckets = buckets
        self.scratch = scratch

    def report_failure(self, event: object, result: str) -> str:
        """يبلّغ الخادم بفشل نهائي فتنتقل الجلسة إلى failed بدل أن تبقى completed بلا أثر. الخادم يرد 409 إن كانت
        الجلسة قد قُضي فيها (مثلًا تحققت ثم فشلت النسخة الخفيفة)، فلا يقلب تحققًا ناجحًا إلى فشل."""
        session_id = ((event if isinstance(event, dict) else {}).get("payload") or {}).get("upload_session_id")
        if not session_id:
            return "no-session"
        try:
            reply = self.api.report_verification(session_id, {"result": result})
        except ApiConflict:
            return "already-decided"
        return f"reported:{reply.get('state', '?')}"

    def handle(self, event: dict) -> str:
        """يعيد وصفًا قصيرًا لما حدث (للسجل والاختبارات)."""
        payload = event.get("payload") or {}
        if event.get("type") == "catalog.listing_changed" and self.enable_store_preview:
            if payload.get("state") != "listed" or not payload.get("material_id"):
                return "ignored"
            return self.store_preview(payload["material_id"])
        session_id = (event.get("payload") or {}).get("upload_session_id")
        if event.get("type") not in VERIFY_EVENTS or not session_id:
            return "ignored"
        return self.process(session_id)

    def process(self, session_id: str) -> str:
        session = self.api.get_session(session_id)
        resume = session.state == "verified" and session.kind in ("original", "voice_note")
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

            body = {"result": "verified", "sha256": digest.sha256, **digest.fingerprint(), "technical": info.to_dict()}
            if self.enable_phash and info.video_codec:
                try:  # غير مانعة: فشل البصمة لا يُفشل التحقق، والحقل يُترك خارج الجسم
                    body["perceptual_hash"] = video_phash(local)
                except Exception as err:  # noqa: BLE001
                    log.warning("perceptual hash skipped session=%s error=%s", session_id, type(err).__name__)
            result = self.api.report_verification(session_id, body)
            if result.get("state") != "verified":
                return result.get("failure_reason") or "failed"
            if session.kind == "voice_note" and info.audio_codec:
                return "verified" + self._speech(session, result["file_id"], local, info, resume)
            if session.kind != "original":
                return "verified"
            file_id, outcome = result["file_id"], "verified"
            if not resume:
                if info.audio_codec:
                    outcome += self._waveform(session, file_id, local, info)
                if info.video_codec:
                    outcome += self._thumbnails(session, file_id, local, info)
            proxy_path = None
            key = proxy_key(session.material_id, file_id)
            if info.video_codec and resume and self._exists(key):
                self._register_existing(file_id, "proxy", key, local.with_name("proxy-480p.mp4"))
                return outcome + "+proxy-existing"
            if info.video_codec:
                proxy_path, proxy_info = self._proxy(session, file_id, local, info)
                outcome += "+proxy"
                if self.enable_hls:
                    outcome += self._hls(session, file_id, proxy_path, proxy_info)
            if self.enable_export and info.video_codec:
                outcome += self._export(session, file_id, local, info, digest, proxy_path)
            return outcome

    def _register(self, file_id: str, body: dict) -> bool:
        """تسجيل مشتق غير مانع: نوع لا يقبله الخادم بعد (422) أو مسجّل بغيره (409) لا يعيد الحدث."""
        try:
            self.api.add_derivative(file_id, body)
            return True
        except (ApiRejected, ApiConflict) as err:
            log.warning("derivative not registered kind=%s file=%s error=%s", body["kind"], file_id,
                        type(err).__name__)
            return False

    def _waveform(self, session: Session, file_id: str, local: Path, info: Probe) -> str:
        try:
            path = write_waveform(local, local.with_name("waveform.json"), info.duration_ms)
            d = digest_file(path)
            key = waveform_key(session.material_id, file_id)
            self.storage.put_file(self.buckets.derived, key, path, d.sha256, "application/json")
        except Exception as err:  # noqa: BLE001
            log.warning("waveform skipped file=%s error=%s", file_id, type(err).__name__)
            return "+waveform-failed"
        ok = self._register(file_id, {"kind": "audio", "storage_key": key, "sha256": d.sha256,
                                      "size_bytes": d.size_bytes,
                                      "technical": {"duration_ms": info.duration_ms, "start_pts_us": info.start_pts_us,
                                                    "container": "json"}})
        return "+waveform" if ok else "+waveform-unregistered"

    def _hls(self, session: Session, file_id: str, proxy_path: Path, proxy_info: Probe) -> str:
        try:
            files = make_hls(proxy_path, proxy_path.with_name("hls"), proxy_info.duration_ms)
            prefix = hls_prefix(session.material_id, file_id)
            for f in files:
                ctype = {"m3u8": "application/vnd.apple.mpegurl", "m4s": "video/iso.segment"}.get(
                    f.suffix.lstrip("."), "video/mp4")
                self.storage.put_file(self.buckets.derived, prefix + f.name, f, digest_file(f).sha256, ctype)
        except Exception as err:  # noqa: BLE001
            log.warning("hls skipped file=%s error=%s", file_id, type(err).__name__)
            return "+hls-failed"
        d = digest_file(files[0])
        ok = self._register(file_id, {"kind": "hls", "storage_key": prefix + files[0].name, "sha256": d.sha256,
                                      "size_bytes": d.size_bytes, "technical": proxy_info.to_dict()})
        return "+hls" if ok else "+hls-unregistered"

    def _export(self, session: Session, file_id: str, local: Path, info: Probe, digest: Digest,
                proxy: Path | None) -> str:
        """غير مانعة. النسخة الخفيفة تدخل الحزمة إن صنعها العامل؛ نسخة الهاتف ليست في مجلد المهمة (قيد معروف)."""
        try:
            out = local.with_name("export.zip")
            build_package(out, original=local, info=info, material_id=session.material_id, file_id=file_id,
                          sha256=digest.sha256, size_bytes=digest.size_bytes, proxy=proxy)
            d = digest_file(out)
            key = export_key(session.material_id, file_id)
            self.storage.put_file(self.buckets.derived, key, out, d.sha256, "application/zip")
        except Exception as err:  # noqa: BLE001
            log.warning("export skipped file=%s error=%s", file_id, type(err).__name__)
            return "+export-failed"
        ok = self._register(file_id, {"kind": "export", "storage_key": key, "sha256": d.sha256,
                                      "size_bytes": d.size_bytes,
                                      "technical": {"duration_ms": info.duration_ms, "start_pts_us": info.start_pts_us,
                                                    "container": "zip"}})
        return "+export" if ok else "+export-unregistered"

    def _thumbnails(self, session: Session, file_id: str, local: Path, info: Probe) -> str:
        """غير مانعة: أي فشل هنا يُسجَّل ويُترك، والمصغّرات يمكن توليدها لاحقًا من الأصل."""
        try:
            made = [(poster(local, local.with_name("poster.jpg"), info), poster_key(session.material_id, file_id)),
                    (contact_sheet(local, local.with_name("contact-sheet.jpg"), info),
                     contact_sheet_key(session.material_id, file_id))]
            for thumb, key in made:
                d = digest_file(thumb.path)
                self.storage.put_file(self.buckets.derived, key, thumb.path, d.sha256, "image/jpeg")
        except Exception as err:  # noqa: BLE001
            log.warning("thumbnails skipped file=%s error=%s", file_id, type(err).__name__)
            return "+thumbnails-failed"
        (poster_thumb, key), _ = made
        d = digest_file(poster_thumb.path)
        # الصفيحة بجوار الملصق باسم ثابت؛ يُسجَّل الملصق وحده لأن (derived_from_id، kind) فريد في الخادم
        if not self._register(file_id, {
            "kind": "thumbnail", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
            "technical": {"duration_ms": 0, "start_pts_us": round((poster_thumb.at_s or 0) * 1_000_000),
                          "width": poster_thumb.width, "height": poster_thumb.height,
                          "container": "jpeg", "video_codec": "mjpeg"},
        }):
            return "+thumbnails-unregistered"
        return "+thumbnails"

    def _exists(self, key: str) -> bool:
        try:
            self.storage.head(self.buckets.derived, key)
            return True
        except ObjectMissing:
            return False

    def _register_existing(self, file_id: str, kind: str, key: str, out: Path) -> None:
        """رُفع في تسليم سابق ولم يُقَرّ الحدث (تعطل بعد الرفع أو قبل الإقرار): يُنزَّل ويُسجَّل كما هو."""
        d = _download(self.storage, self.buckets.derived, key, out)
        self.api.add_derivative(file_id, {
            "kind": kind, "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
            "technical": probe(out).to_dict(),
        })

    def store_preview(self, material_id: str) -> str:
        """معاينة المتجر من الأصل المتحقق عند الإدراج. مكررة الأثر: إعادة الإدراج أو التسليم تعيد تسجيل المرفوعة."""
        ref = self.api.get_material_original(material_id)
        key = store_preview_key(material_id, ref.file_id)
        with tempfile.TemporaryDirectory(dir=self.scratch, prefix="job-") as tmp:
            out = Path(tmp) / "preview-watermarked.mp4"
            if self._exists(key):
                self._register_existing(ref.file_id, "watermarked_preview", key, out)
                return "store-preview-existing"
            local = Path(tmp) / "source"
            digest = _download(self.storage, self.buckets.uploads, ref.storage_key, local)
            if digest.sha256 != ref.sha256:
                raise ValueError("original does not match its recorded hash")
            info = probe(local)
            made = make_watermarked_preview(local, out, info, self.watermark_key, material_id)
            d = digest_file(out)
            self.storage.put_file(self.buckets.derived, key, out, d.sha256, "video/mp4")
            self.api.add_derivative(ref.file_id, {
                "kind": "watermarked_preview", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
                "technical": made.to_dict(),
            })
        return "store-preview"

    def _speech(self, session: Session, file_id: str, local: Path, info: Probe, resume: bool) -> str:
        """مانعة كالنسخة الخفيفة: فشلها يعيد الحدث، والاستئناف يعيد تسجيل المرفوعة كما هي."""
        out = local.with_name("audio-16k.m4a")
        key = speech_key(session.material_id, file_id)
        if resume and self._exists(key):
            self._register_existing(file_id, "audio", key, out)
            return "+audio-existing"
        made = make_speech_audio(local, out, info)
        d = digest_file(out)
        self.storage.put_file(self.buckets.derived, key, out, d.sha256, "audio/mp4")
        self.api.add_derivative(file_id, {
            "kind": "audio", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
            "technical": made.to_dict(),
        })
        return "+audio"

    def _proxy(self, session: Session, file_id: str, local: Path, info: Probe) -> tuple[Path, Probe]:
        out = local.with_name("proxy-480p.mp4")
        made = make_proxy(local, out, info)
        d = digest_file(out)
        key = proxy_key(session.material_id, file_id)
        self.storage.put_file(self.buckets.derived, key, out, d.sha256, "video/mp4")
        self.api.add_derivative(file_id, {
            "kind": "proxy", "storage_key": key, "sha256": d.sha256, "size_bytes": d.size_bytes,
            "technical": made.to_dict(),
        })
        return out, made
