"""الخدمة: تستهلك `media:events` بمجموعة مستهلكين `ai` مستقلة عن مجموعة عامل الوسائط (ADR 0020).

كل مجموعة ترى كل الأحداث وتؤكد ما يخصها، فلا يحجب أحد العاملين الآخر. المأخوذ من عامل الوسائط
(`workers/media/src/media_worker/service.py`):

- `XREADGROUP` للجديد و`XAUTOCLAIM` لما علق بعد `AI_CLAIM_IDLE_MS`. المهمة الواحدة قد تطول (مقطع 30 دقيقة نحو
  17 دقيقة على معالجين)، فالمهلة 30 دقيقة كي لا يأخذ مستهلك ثانٍ مهمة جارية؛ مع أكثر من نسخة تُضبط فوق أطول مهمة.
- النجاح أو التجاهل ← `XACK`. العطل المؤقت، ومنه نسخة خفيفة لم تُرفع بعد ← بلا تأكيد فيُعاد لاحقًا.
- تجاوز `AI_MAX_DELIVERIES` محاولة أو خطأ نهائي ← `ai:dead` مع السبب ثم `XACK`.
- رفض المصادقة (401/403/404) ← تراجع أسّي دون إقرار، ثم العزل بسبب `config_error` بعد `AI_AUTH_ISOLATE_AFTER_S`.
- 410 ← `ai:dead` بسبب `gone`.

الفرق: هذا العامل لا يبلّغ الخادم بفشل. التفريغ مشتق اختياري، وفشله لا يغيّر حالة المادة ولا حكمًا على الملف.
السجل: معرّف الحدث ونوعه والنتيجة فقط، لا حمولة ولا نص ولا مفاتيح تخزين.
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

from .api import ApiAuthError, ApiGone, InternalApi
from .jobs import Jobs
from .storage import S3Storage
from .transcribe import NoAudioError

log = logging.getLogger("ai_worker.service")

STREAM = "media:events"
DEAD = "ai:dead"
GROUP = "ai"
PERMANENT = (ValueError, KeyError, PermissionError)
AUTH_BACKOFF_FIRST_S = 1.0


def clean_scratch(scratch: Path) -> int:
    """يحذف مجلدات المهام (`job-*`) التي تركها عامل قُتل أثناء مهمة؛ يُستدعى عند الإقلاع."""
    removed = 0
    for d in scratch.glob("job-*"):
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


def read_manifest(models_dir: Path, model: str) -> dict:
    """بصمة ملف الأوزان من MANIFEST الذي كتبه `ai-models` بعد التحقق (ADR 0019)، لتُذكر في المسودة."""
    try:
        lines = (models_dir / "MANIFEST").read_text().splitlines()
    except OSError:
        return {"model": model}
    for line in lines:
        parts = line.split()
        if len(parts) == 3 and parts[0] == model and parts[1].endswith("/model.bin"):
            return {"model": model, "weights_sha256": parts[2]}
    return {"model": model}


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
    bucket_derived: str
    scratch: Path
    models_dir: Path
    model: str
    consumer: str
    enabled: bool = False
    cpu_threads: int = 0
    proxy_wait_s: float = 300.0
    block_ms: int = 5000
    claim_idle_ms: int = 30 * 60 * 1000
    max_deliveries: int = 5
    auth_backoff_max_s: float = 300.0
    auth_isolate_after_s: float = 1800.0

    @classmethod
    def from_env(cls) -> Config:
        e = os.environ
        return cls(
            redis_url=e["REDIS_URL"], api_url=e["AI_API_URL"], token=e["AI_WORKER_TOKEN"],
            s3_endpoint=e["S3_ENDPOINT"], s3_region=e.get("S3_REGION", "auto"),
            s3_access_key=e["S3_ACCESS_KEY"], s3_secret_key=e["S3_SECRET_KEY"], bucket_derived=e["S3_BUCKET_MEDIA"],
            scratch=Path(e.get("AI_SCRATCH_DIR", "/scratch")), models_dir=Path(e.get("AI_MODELS_DIR", "/models")),
            model=e.get("AI_MODEL", "faster-whisper-large-v3-turbo"),
            consumer=e.get("AI_CONSUMER", socket.gethostname()),
            enabled=e.get("AI_ENABLE_TRANSCRIPT", "false").lower() == "true",
            cpu_threads=int(e.get("AI_CPU_THREADS", 0)),
            proxy_wait_s=float(e.get("AI_PROXY_WAIT_S", 300)),
            claim_idle_ms=int(e.get("AI_CLAIM_IDLE_MS", 30 * 60 * 1000)),
            max_deliveries=int(e.get("AI_MAX_DELIVERIES", 5)),
            auth_backoff_max_s=float(e.get("AI_AUTH_BACKOFF_MAX_S", 300)),
            auth_isolate_after_s=float(e.get("AI_AUTH_ISOLATE_AFTER_S", 1800)),
        )


class Service:
    def __init__(self, r: redis.Redis, jobs: Jobs, consumer: str, block_ms: int = 5000,
                 claim_idle_ms: int = 30 * 60 * 1000, max_deliveries: int = 5, auth_backoff_max_s: float = 300.0,
                 sleep=time.sleep, auth_isolate_after_s: float = 1800.0):
        self.r = r
        self.jobs = jobs
        self.consumer = consumer
        self.block_ms = block_ms
        self.claim_idle_ms = claim_idle_ms
        self.max_deliveries = max_deliveries
        self.auth_backoff_max_s = auth_backoff_max_s
        self.auth_isolate_after_s = auth_isolate_after_s
        self.sleep = sleep
        self.stopped = False

    def ensure_group(self) -> None:
        try:
            # من آخر الدفق: مواد استُوعبت قبل تشغيل العامل لا تُفرَّغ دفعة واحدة عند أول إقلاع
            self.r.xgroup_create(STREAM, GROUP, id="$", mkstream=True)
        except redis.ResponseError as err:
            if "BUSYGROUP" not in str(err):
                raise

    def _deliveries(self, entry_id: str) -> int:
        pending = self.r.xpending_range(STREAM, GROUP, min=entry_id, max=entry_id, count=1)
        return int(pending[0]["times_delivered"]) if pending else 1

    def _dead_letter(self, entry_id: str, fields: dict, reason: str) -> str:
        self.r.xadd(DEAD, {"entry_id": entry_id, **fields, "reason": reason}, maxlen=10000, approximate=True)
        self.r.xack(STREAM, GROUP, entry_id)
        log.error("event dead-lettered entry=%s reason=%s", entry_id, reason)
        return f"dead:{reason}"

    def _wait(self, seconds: float) -> None:
        left = seconds
        while not self.stopped and left > 0:
            step = min(1.0, left)
            self.sleep(step)
            left -= step

    def process(self, entry_id: str, fields: dict) -> str:
        try:
            event = json.loads(fields.get("event", "{}"))
        except ValueError:
            event = None
        if not isinstance(event, dict):
            return self._dead_letter(entry_id, fields, "malformed_event")
        if self._deliveries(entry_id) > self.max_deliveries:
            return self._dead_letter(entry_id, fields, "max_deliveries")
        delay, waited = AUTH_BACKOFF_FIRST_S, 0.0
        while True:
            try:
                outcome = self.jobs.handle(event)
                break
            except ApiAuthError:
                if self.stopped:
                    return "deferred:auth"
                if waited >= self.auth_isolate_after_s:
                    return self._dead_letter(entry_id, fields, "config_error")
                log.warning("internal API refused the worker token; retrying entry=%s in %.0fs", entry_id, delay)
                self._wait(delay)
                waited += delay
                self.r.xclaim(STREAM, GROUP, self.consumer, min_idle_time=0, message_ids=[entry_id], justid=True)
                delay = min(delay * 2, self.auth_backoff_max_s)
            except ApiGone:
                return self._dead_letter(entry_id, fields, "gone")
            except NoAudioError:
                outcome = "skip:no-audio"
                break
            except PERMANENT as err:
                return self._dead_letter(entry_id, fields, type(err).__name__)
            except Exception as err:  # عطل مؤقت (تخزين، شبكة، 5xx، نسخة لم تُرفع): يبقى معلّقًا ويُستعاد لاحقًا
                log.warning("event deferred entry=%s error=%s", entry_id, type(err).__name__)
                return f"deferred:{type(err).__name__}"
        self.r.xack(STREAM, GROUP, entry_id)
        if outcome != "ignored":
            log.info("event done entry=%s type=%s outcome=%s", entry_id, event.get("type"), outcome)
        return outcome

    def next_entries(self) -> list[tuple[str, dict]]:
        claimed = self.r.xautoclaim(STREAM, GROUP, self.consumer, min_idle_time=self.claim_idle_ms,
                                    start_id="0-0", count=1)
        if claimed[1]:
            return claimed[1]
        res = self.r.xreadgroup(GROUP, self.consumer, {STREAM: ">"}, count=1, block=self.block_ms)
        return res[0][1] if res else []

    def run_once(self) -> int:
        entries = self.next_entries()
        for entry_id, fields in entries:
            self.process(entry_id, fields)
        return len(entries)

    def run(self) -> None:
        self.ensure_group()
        while not self.stopped:
            self.run_once()


def build(cfg: Config) -> Service:
    engine = None
    if cfg.enabled:
        from .transcribe import FasterWhisperEngine

        engine = FasterWhisperEngine(cfg.models_dir / cfg.model, cpu_threads=cfg.cpu_threads)
    storage = S3Storage(cfg.s3_endpoint, cfg.s3_region, cfg.s3_access_key, cfg.s3_secret_key, cfg.bucket_derived)
    jobs = Jobs(InternalApi(cfg.api_url, cfg.token), storage, engine, cfg.bucket_derived, cfg.scratch,
                enabled=cfg.enabled, weights=read_manifest(cfg.models_dir, cfg.model), proxy_wait_s=cfg.proxy_wait_s)
    return Service(redis.Redis.from_url(cfg.redis_url, decode_responses=True), jobs, cfg.consumer, cfg.block_ms,
                   cfg.claim_idle_ms, cfg.max_deliveries, cfg.auth_backoff_max_s,
                   auth_isolate_after_s=cfg.auth_isolate_after_s)


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format='{"level":"%(levelname)s","msg":"%(message)s","logger":"%(name)s"}')
    cfg = Config.from_env()
    cfg.scratch.mkdir(parents=True, exist_ok=True)
    if removed := clean_scratch(cfg.scratch):
        log.warning("removed %d stale job directories from scratch", removed)
    svc = build(cfg)

    def stop(*_):
        svc.stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("ai worker started transcript=%s", "on" if cfg.enabled else "off")
    svc.run()
