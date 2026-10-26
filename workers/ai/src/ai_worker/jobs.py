"""مهمة التفريغ لحدث `upload.verified` (ADR 0020).

1. حدث لأصل (`kind=original`) متحقق منه، وفيه `material_id` و`file_id`؛ غيره يُتجاهل. والعلم `AI_ENABLE_TRANSCRIPT`
   مطفأ ← يُتجاهل أيضًا، إلى أن يقبل الخادم رمز العامل وينشر الحدث (النوعان في عقد v0.2).
2. المصدر النسخة الخفيفة التي صنعها عامل الوسائط من الأصل نفسه: `derived/<material_id>/<file_id>/proxy-480p.mp4`.
   قد يصل الحدث قبلها، أو لا تُصنع أصلًا (مادة أرسل هاتفها نسخته). غيابها `SourceNotReady` بلا انتظار هنا: الخدمة
   تؤجل الحدث في `ai:retry` دون أن تحجب غيره، ثم تسجّل التعذّر في `ai:dead` بعد `AI_SOURCE_WAIT_S`. أصل بلا نسخة
   خفيفة (ملاحظة صوتية، صوت فقط) لا يُفرَّغ في هذه المرحلة.
3. إن وُجد ملفا التفريغ من تسليم سابق فلا تفريغ ثانٍ: يُقرآن ويُسجَّلان كما هما، فيتساوى أثر التكرار ولا يتعارض
   ناتج نموذج غير حتمي مع ما سُجّل.
4. وإلا ينزّل النسخة إلى مجلد المهمة، ويفرّغها، ويكتب `transcript.json` و`transcript.vtt`، ويرفعهما ثم يسجّلهما.

المادة لا تُعدَّل ولا يُنشر شيء: المشتقان مسودة يراجعها المنتج. السجل معرّفات ونتائج فقط، لا نص التفريغ.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import tempfile
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .api import ApiConflict, ApiRejected
from . import quality as quality_mod
from . import shot_list as shot_list_mod
from . import shots as shots_mod
from .captions import Segment, build_cues, to_json, to_webvtt
from .storage import DERIVED_PREFIX, ObjectMissing
from .transcribe import Transcript

log = logging.getLogger("ai_worker.jobs")

EVENT = "upload.verified"
JSON_MIME = "application/json"
VTT_MIME = "text/vtt"


class SourceNotReady(RuntimeError):
    """لا مصدر للتفريغ بعد (النسخة الخفيفة لم تُرفع): يُؤجَّل الحدث ولا يُعاد فورًا."""


class Storage(Protocol):
    def head(self, bucket: str, key: str) -> int: ...
    def read(self, bucket: str, key: str) -> Iterable[bytes]: ...
    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None: ...


class Api(Protocol):
    def add_derivative(self, file_id: str, body: dict) -> dict: ...


class Engine(Protocol):
    describe: dict

    def transcribe(self, path: Path) -> Transcript: ...


def _prefix(material_id: str, file_id: str) -> str:
    return f"{DERIVED_PREFIX}{material_id}/{file_id}/"


def proxy_key(material_id: str, file_id: str) -> str:
    return _prefix(material_id, file_id) + "proxy-480p.mp4"


def transcript_key(material_id: str, file_id: str) -> str:
    return _prefix(material_id, file_id) + "transcript.json"


def captions_key(material_id: str, file_id: str) -> str:
    return _prefix(material_id, file_id) + "transcript.vtt"


def shots_key(material_id: str, file_id: str) -> str:
    return _prefix(material_id, file_id) + "shots.json"


def shot_list_key(material_id: str, file_id: str) -> str:
    return _prefix(material_id, file_id) + "shot_list.json"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _download(storage: Storage, bucket: str, key: str, dst: Path) -> None:
    with open(dst, "wb") as fh:
        for chunk in storage.read(bucket, key):
            fh.write(chunk)


@dataclass
class Jobs:
    api: Api
    storage: Storage
    engine: Engine | None
    bucket: str
    scratch: Path
    enabled: bool = False
    weights: dict = field(default_factory=dict)
    # كشف اللقطات (AI_ENABLE_SHOTS): يُكتب shots.json بجوار التفريغ ولا يُسجَّل حتى يقبل العقد نوعًا له.
    # غير مانع: فشله لا يُفشل التفريغ ولا يعيد الحدث.
    shots_enabled: bool = False
    detect: Callable[..., tuple[list, dict]] = shots_mod.detect_shots
    # تقييم الجودة (الاهتزاز والصمت والتكرار) يُضاف إلى shots.json، وفشله لا يمنع اللقطات
    signals: Callable[[Path], quality_mod.Signals] = quality_mod.read_signals
    # آخر مهمة أُنجزت: أزمنة للقياس (bench/transcribe_bench.py)، لا تُسجَّل
    last_timing: dict = field(default_factory=dict)

    def handle(self, event: dict) -> str:
        if event.get("type") != EVENT:
            return "ignored"
        p = event.get("payload") or {}
        material_id, file_id = p.get("material_id"), p.get("file_id")
        if p.get("kind") != "original" or not material_id or not file_id:
            return "ignored"
        if not self.enabled:
            return "ignored:disabled"
        jkey, vkey = transcript_key(material_id, file_id), captions_key(material_id, file_id)
        job = Path(tempfile.mkdtemp(prefix="job-", dir=self.scratch))
        try:
            if self._exists(jkey) and self._exists(vkey):
                json_path, vtt_path = job / "transcript.json", job / "transcript.vtt"
                _download(self.storage, self.bucket, jkey, json_path)
                _download(self.storage, self.bucket, vkey, vtt_path)
                duration_ms, start_pts_us = self._timing_from_json(json_path)
                out = "reused" + self._register_all(file_id, jkey, json_path, vkey, vtt_path, duration_ms, start_pts_us)
                if self.shots_enabled and not self._exists(shot_list_key(material_id, file_id)) \
                        and self._exists(proxy_key(material_id, file_id)):
                    src = job / "proxy-480p.mp4"
                    _download(self.storage, self.bucket, proxy_key(material_id, file_id), src)
                    out += self._shots(material_id, file_id, src, _segments_from_json(json_path), start_pts_us)
                return out
            if not self._exists(proxy_key(material_id, file_id)):
                raise SourceNotReady("no proxy to transcribe yet")
            src = job / "proxy-480p.mp4"
            _download(self.storage, self.bucket, proxy_key(material_id, file_id), src)
            assert self.engine is not None
            t0 = time.perf_counter()
            result = self.engine.transcribe(src)
            self.last_timing = {"decode_s": result.decode_s, "transcribe_s": result.transcribe_s,
                                "duration_s": result.timing.duration_s, "job_s": time.perf_counter() - t0}
            json_path, vtt_path = job / "transcript.json", job / "transcript.vtt"
            source = {"file_id": file_id, "from": "proxy-480p.mp4"}
            json_path.write_text(to_json(result.segments, duration_s=result.timing.duration_s,
                                         start_pts_us=result.timing.start_pts_us, engine={**self.engine.describe, **self.weights}, source=source),
                                 encoding="utf-8")
            vtt_path.write_text(to_webvtt(build_cues(result.segments)), encoding="utf-8")
            # الترجمة أولًا ثم المسودة: وجود transcript.json يعني أن الملفين رُفعا (الخطوة 3 تشترطهما معًا)
            self.storage.put_file(self.bucket, vkey, vtt_path, _sha256(vtt_path), VTT_MIME)
            self.storage.put_file(self.bucket, jkey, json_path, _sha256(json_path), JSON_MIME)
            duration_ms = max(1, round(result.timing.duration_s * 1000))
            out = "transcribed" + self._register_all(file_id, jkey, json_path, vkey, vtt_path, duration_ms,
                                                     result.timing.start_pts_us)
            if self.shots_enabled:
                out += self._shots(material_id, file_id, src, result.segments, result.timing.start_pts_us)
            return out
        finally:
            shutil.rmtree(job, ignore_errors=True)

    def _shots(self, material_id: str, file_id: str, src: Path, segments: list[Segment], start_pts_us: int) -> str:
        try:
            found, stats = self.detect(src, origin_s=start_pts_us / 1e6)
            quality = self._quality(file_id, src, found, start_pts_us)
            path = src.with_name("shots.json")
            path.write_text(shots_mod.to_json(found, segments, source={"file_id": file_id, "from": "proxy-480p.mp4"},
                                              stats=stats, quality=quality), encoding="utf-8")
            self.storage.put_file(self.bucket, shots_key(material_id, file_id), path, _sha256(path), JSON_MIME)
            # قائمة اللقطات (ADR 0026): تُكتب ولا تُسجَّل حتى يقبل العقد نوع shot_list
            lpath = src.with_name("shot_list.json")
            lpath.write_text(shot_list_mod.to_json(found, segments, source={"file_id": file_id, "from": "proxy-480p.mp4"}),
                             encoding="utf-8")
            self.storage.put_file(self.bucket, shot_list_key(material_id, file_id), lpath, _sha256(lpath), JSON_MIME)
        except Exception as err:  # noqa: BLE001 (خطوة غير مانعة)
            log.warning("shot detection skipped file=%s error=%s", file_id, type(err).__name__)
            return "+shots-failed"
        return "+shots"

    def _quality(self, file_id: str, src: Path, found: list, start_pts_us: int):
        try:
            sig = self.signals(src)
            return quality_mod.assess(found, sig, origin_s=start_pts_us / 1e6) if sig.times else None
        except Exception as err:  # noqa: BLE001 (خطوة غير مانعة)
            log.warning("quality assessment skipped file=%s error=%s", file_id, type(err).__name__)
            return None

    def _exists(self, key: str) -> bool:
        try:
            self.storage.head(self.bucket, key)
            return True
        except ObjectMissing:
            return False

    @staticmethod
    def _timing_from_json(path: Path) -> tuple[int, int]:
        import json

        doc = json.loads(path.read_text(encoding="utf-8"))
        return max(1, round(float(doc["duration_s"]) * 1000)), int(doc["start_pts_us"])

    def _register_all(self, file_id: str, jkey: str, json_path: Path, vkey: str, vtt_path: Path,
                      duration_ms: int, start_pts_us: int) -> str:
        out = ""
        for kind, key, path, mime, container in (("transcript", jkey, json_path, JSON_MIME, "json"),
                                                 ("captions", vkey, vtt_path, VTT_MIME, "webvtt")):
            body = {"kind": kind, "storage_key": key, "sha256": _sha256(path), "size_bytes": path.stat().st_size,
                    "mime_type": mime,
                    "technical": {"duration_ms": duration_ms, "start_pts_us": start_pts_us, "container": container}}
            try:
                self.api.add_derivative(file_id, body)
                out += f"+{kind}"
            except (ApiRejected, ApiConflict) as err:
                # 422 قبل أن يقبل العقد النوع، أو 409 لمشتق مختلف: الملفات في مكانها، ولا إعادة تلقائية
                log.warning("derivative not registered kind=%s file=%s error=%s", kind, file_id, type(err).__name__)
                out += f"+{kind}-unregistered"
        return out


def _segments_from_json(path: Path) -> list[Segment]:
    """مقاطع transcript.json (بعد حذف الفارغة عند الكتابة) لربط اللقطات بها عند إعادة الاستعمال."""
    import json

    doc = json.loads(path.read_text(encoding="utf-8"))
    return [Segment(float(s["start"]), float(s["end"]), s["text"], ()) for s in doc["segments"]]
