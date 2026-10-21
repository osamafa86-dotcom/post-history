"""الخدمة: تستهلك Redis Stream `media:events` بمجموعة مستهلكين وتشغّل `Jobs` لكل حدث (ADR 0006).

- `XREADGROUP` للجديد و`XAUTOCLAIM` لما علق عند مستهلك توقف (بعد `MEDIA_CLAIM_IDLE_MS`).
- النجاح أو التجاوز ← `XACK`. العطل المؤقت ← بلا تأكيد فيُعاد لاحقًا.
- الفشل النهائي، أو تجاوز `MEDIA_MAX_DELIVERIES` محاولة: يُبلَّغ الخادم بنتيجة فشل (فلا تبقى الجلسة `completed` بلا
  أثر)، ثم يُنقل الحدث إلى `media:dead` مع السبب ويُؤكد، فلا يحجب حدث معطوب الطابور ولا يختفي بصمت.
- رفض المصادقة (401/403/404) خطأ تهيئة لا حكم على الحدث: يُعاد الحدث نفسه بتراجع أسّي حتى `MEDIA_AUTH_BACKOFF_MAX_S`
  دون إقرار ودون احتساب محاولة، فيمر تدوير `MEDIA_WORKER_TOKEN` دون فقد أحداث. إن طال (مجموع الانتظار ≥
  `MEDIA_AUTH_ISOLATE_AFTER_S`) يُعزل الحدث في `media:dead` بسبب `config_error` دون إبلاغ الخادم بفشل (الملف بريء)،
  ويتابع العامل؛ بعد إصلاح التهيئة يعيده `python -m media_worker requeue-dead config_error` إلى الطابور.
- 410 (`media_resource_gone`: الرمز صحيح والجلسة أو الملف غير موجود) ← `media:dead` بسبب `gone` فورًا، بلا إعادة
  محاولة وبلا إبلاغ (لا شيء يُبلَّغ عنه).
- عند الإقلاع تُحذف مجلدات مهام قديمة في `/scratch` تركها عامل قُتل أثناء مهمة.
- السجل: معرّف الحدث ونوعه والنتيجة فقط؛ لا حمولة ولا مفاتيح تخزين ولا رسائل ffmpeg.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path

import redis

from .api import ApiAuthError, ApiConflict, ApiGone, ApiRejected, InternalApi
from .jobs import Buckets, Jobs
from .probe import InvalidMediaError
from .proxy import ProxyTimingError
from .storage import S3Storage

log = logging.getLogger("media_worker.service")

STREAM = "media:events"
DEAD = "media:dead"
GROUP = "media"
# أخطاء لا تزول بإعادة المحاولة على الملف نفسه
# (فشل ffmpeg قد يكون نفاد ذاكرة أو مهلة، فيُعاد حتى MEDIA_MAX_DELIVERIES ثم يُنقل إلى media:dead)
PERMANENT = (ApiRejected, ApiConflict, InvalidMediaError, ProxyTimingError, ValueError, KeyError)
# نتيجة الفشل التي تُبلَّغ للخادم: الملف نفسه غير صالح، أو تعذّرت معالجته عندنا
FILE_FAULTS = (InvalidMediaError, ProxyTimingError)
AUTH_BACKOFF_FIRST_S = 1.0


def clean_scratch(scratch: Path) -> int:
    """يحذف مجلدات المهام (`job-*`) المتروكة؛ يُستدعى عند الإقلاع قبل أي مهمة، فلا يمس مهمة جارية."""
    removed = 0
    for d in scratch.glob("job-*"):
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


@dataclass(frozen=True)
class Config:
    # repr=False: الحقول السرية لا تظهر في repr ولا في أي استثناء أو سجل يطبع الإعداد
    redis_url: str = field(repr=False)
    api_url: str
    token: str = field(repr=False)
    s3_endpoint: str
    s3_region: str
    s3_access_key: str = field(repr=False)
    s3_secret_key: str = field(repr=False)
    bucket_uploads: str
    bucket_derived: str
    scratch: Path
    consumer: str
    block_ms: int = 5000
    claim_idle_ms: int = 15 * 60 * 1000
    max_deliveries: int = 5
    auth_backoff_max_s: float = 300.0
    auth_isolate_after_s: float = 1800.0
    enable_hls: bool = False
    enable_phash: bool = False
    enable_export: bool = False
    enable_store_preview: bool = False

    @classmethod
    def from_env(cls) -> Config:
        e = os.environ
        return cls(
            redis_url=e["REDIS_URL"], api_url=e["MEDIA_API_URL"], token=e["MEDIA_WORKER_TOKEN"],
            s3_endpoint=e["S3_ENDPOINT"], s3_region=e.get("S3_REGION", "auto"),
            s3_access_key=e["S3_ACCESS_KEY"], s3_secret_key=e["S3_SECRET_KEY"],
            bucket_uploads=e["S3_BUCKET_UPLOADS"], bucket_derived=e["S3_BUCKET_MEDIA"],
            scratch=Path(e.get("MEDIA_SCRATCH_DIR", "/scratch")),
            consumer=e.get("MEDIA_CONSUMER", socket.gethostname()),
            claim_idle_ms=int(e.get("MEDIA_CLAIM_IDLE_MS", 15 * 60 * 1000)),
            max_deliveries=int(e.get("MEDIA_MAX_DELIVERIES", 5)),
            auth_backoff_max_s=float(e.get("MEDIA_AUTH_BACKOFF_MAX_S", 300)),
            auth_isolate_after_s=float(e.get("MEDIA_AUTH_ISOLATE_AFTER_S", 1800)),
            enable_hls=e.get("MEDIA_ENABLE_HLS", "false").lower() == "true",
            enable_phash=e.get("MEDIA_ENABLE_PHASH", "false").lower() == "true",
            enable_export=e.get("MEDIA_ENABLE_EXPORT", "false").lower() == "true",
            enable_store_preview=e.get("MEDIA_ENABLE_STORE_PREVIEW", "false").lower() == "true",
        )


class Service:
    def __init__(self, r: redis.Redis, jobs: Jobs, consumer: str, block_ms: int = 5000,
                 claim_idle_ms: int = 15 * 60 * 1000, max_deliveries: int = 5, auth_backoff_max_s: float = 300.0,
                 sleep=time.sleep, auth_isolate_after_s: float = 1800.0):
        self.r = r
        self.auth_backoff_max_s = auth_backoff_max_s
        self.auth_isolate_after_s = auth_isolate_after_s
        self.sleep = sleep
        self.jobs = jobs
        self.consumer = consumer
        self.block_ms = block_ms
        self.claim_idle_ms = claim_idle_ms
        self.max_deliveries = max_deliveries
        self.stopped = False

    def ensure_group(self) -> None:
        try:
            # من بداية الدفق: ما نُشر قبل أول تشغيل للعامل يُعالج أيضًا
            self.r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
        except redis.ResponseError as err:
            if "BUSYGROUP" not in str(err):
                raise

    def _deliveries(self, entry_id: str) -> int:
        pending = self.r.xpending_range(STREAM, GROUP, min=entry_id, max=entry_id, count=1)
        return int(pending[0]["times_delivered"]) if pending else 1

    def _dead_letter(self, entry_id: str, fields: dict, event: object, reason: str, result: str | None) -> str:
        if result is None:
            reported = "not-reported"
        else:
            try:
                reported = self.jobs.report_failure(event, result)
            except Exception as err:  # الإبلاغ نفسه فشل: يُنقل الحدث على أي حال حتى لا يحجب الطابور، والسبب محفوظ
                reported = f"report-failed:{type(err).__name__}"
        self.r.xadd(DEAD, {"entry_id": entry_id, **fields, "reason": reason, "reported": reported},
                    maxlen=10000, approximate=True)
        self.r.xack(STREAM, GROUP, entry_id)
        log.error("event dead-lettered entry=%s reason=%s reported=%s", entry_id, reason, reported)
        return f"dead:{reason}"

    def _wait(self, seconds: float) -> None:
        """انتظار يقطعه SIGTERM خلال ثانية، لا بعد انتهاء تراجع قد يبلغ دقائق."""
        left = seconds
        while not self.stopped and left > 0:
            step = min(1.0, left)
            self.sleep(step)
            left -= step

    def _parse(self, fields: dict) -> object:
        try:
            return json.loads(fields.get("event", "{}"))
        except ValueError:
            return None

    def process(self, entry_id: str, fields: dict) -> str:
        event = self._parse(fields)
        if self._deliveries(entry_id) > self.max_deliveries:
            return self._dead_letter(entry_id, fields, event, "max_deliveries", "storage_error")
        if not isinstance(event, dict):
            return self._dead_letter(entry_id, fields, event, "malformed_event", "storage_error")
        delay, waited = AUTH_BACKOFF_FIRST_S, 0.0
        while True:
            try:
                outcome = self.jobs.handle(event)
                break
            except ApiAuthError:
                if self.stopped:
                    return "deferred:auth"
                if waited >= self.auth_isolate_after_s:
                    # خطأ تهيئة طويل لا يسد الطابور: يُعزل الحدث بلا حكم على الملف، ويُعاد لاحقًا بـ requeue-dead
                    return self._dead_letter(entry_id, fields, event, "config_error", None)
                # الحدث يبقى عند هذا المستهلك: يُجدَّد خموله (JUSTID لا يزيد عدد التسليم) فلا يأخذه غيره
                log.warning("internal API refused the worker token; retrying entry=%s in %.0fs", entry_id, delay)
                self._wait(delay)
                waited += delay
                self.r.xclaim(STREAM, GROUP, self.consumer, min_idle_time=0, message_ids=[entry_id], justid=True)
                delay = min(delay * 2, self.auth_backoff_max_s)
            except ApiGone:
                return self._dead_letter(entry_id, fields, event, "gone", None)
            except PERMANENT as err:
                result = "invalid_file" if isinstance(err, FILE_FAULTS) else "storage_error"
                return self._dead_letter(entry_id, fields, event, type(err).__name__, result)
            except Exception as err:  # عطل مؤقت (تخزين، شبكة، 5xx، ffmpeg): يبقى معلّقًا ويُستعاد لاحقًا
                log.warning("event deferred entry=%s error=%s", entry_id, type(err).__name__)
                return f"deferred:{type(err).__name__}"
        self.r.xack(STREAM, GROUP, entry_id)
        log.info("event done entry=%s type=%s outcome=%s", entry_id, event.get("type"), outcome)
        return outcome

    def next_entries(self) -> list[tuple[str, dict]]:
        claimed = self.r.xautoclaim(STREAM, GROUP, self.consumer, min_idle_time=self.claim_idle_ms,
                                    start_id="0-0", count=1)
        if claimed[1]:
            return claimed[1]
        res = self.r.xreadgroup(GROUP, self.consumer, {STREAM: ">"}, count=1, block=self.block_ms)
        return res[0][1] if res else []

    def requeue_dead(self, reason: str) -> int:
        """يعيد أحداث `media:dead` ذات السبب المعطى إلى الطابور (بعد إصلاح التهيئة مثلًا) ويحذفها من الموتى."""
        moved = 0
        for dead_id, fields in self.r.xrange(DEAD):
            if fields.get("reason") != reason:
                continue
            original = {k: v for k, v in fields.items() if k in ("event_id", "event")}
            self.r.xadd(STREAM, original)
            self.r.xdel(DEAD, dead_id)
            moved += 1
        return moved

    def run_once(self) -> int:
        entries = self.next_entries()
        for entry_id, fields in entries:
            self.process(entry_id, fields)
        return len(entries)

    def run(self) -> None:
        self.ensure_group()
        while not self.stopped:
            self.run_once()


def requeue_main(reason: str) -> None:
    """أداة تشغيل: `python -m media_worker requeue-dead <reason>`؛ تكفيها REDIS_URL."""
    svc = Service(redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True), None, "requeue")  # type: ignore[arg-type]
    print(f"requeued {svc.requeue_dead(reason)} event(s) with reason={reason}")


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format='{"level":"%(levelname)s","msg":"%(message)s","logger":"%(name)s"}')
    cfg = Config.from_env()
    cfg.scratch.mkdir(parents=True, exist_ok=True)
    if removed := clean_scratch(cfg.scratch):
        log.warning("removed %d stale job directories from scratch", removed)
    storage = S3Storage(cfg.s3_endpoint, cfg.s3_region, cfg.s3_access_key, cfg.s3_secret_key, cfg.bucket_derived)
    jobs = Jobs(InternalApi(cfg.api_url, cfg.token), storage, Buckets(cfg.bucket_uploads, cfg.bucket_derived),
                cfg.scratch, enable_hls=cfg.enable_hls, enable_phash=cfg.enable_phash,
                enable_export=cfg.enable_export,
                enable_store_preview=cfg.enable_store_preview)
    svc = Service(redis.Redis.from_url(cfg.redis_url, decode_responses=True), jobs, cfg.consumer, cfg.block_ms,
                  cfg.claim_idle_ms, cfg.max_deliveries, cfg.auth_backoff_max_s,
                  auth_isolate_after_s=cfg.auth_isolate_after_s)

    def stop(*_):
        svc.stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("media worker started")
    svc.run()


if __name__ == "__main__":
    main()
