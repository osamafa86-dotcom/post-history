"""الخدمة: تستهلك Redis Stream `media:events` بمجموعة مستهلكين وتشغّل `Jobs` لكل حدث (ADR 0006).

- `XREADGROUP` للجديد و`XAUTOCLAIM` لما علق عند مستهلك توقف (بعد `MEDIA_CLAIM_IDLE_MS`).
- النجاح أو الرفض النهائي أو التعارض ← `XACK`. العطل المؤقت ← بلا تأكيد فيُعاد لاحقًا.
- بعد `MEDIA_MAX_DELIVERIES` محاولة يُنقل الحدث إلى `media:dead` ويُؤكد، فلا يحجب حدث معطوب الطابور.
- السجل: معرّف الحدث ونوعه والنتيجة فقط؛ لا حمولة ولا مفاتيح تخزين ولا رسائل ffmpeg.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
from dataclasses import dataclass
from pathlib import Path

import redis

from .api import ApiConflict, ApiRejected, InternalApi
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


@dataclass(frozen=True)
class Config:
    redis_url: str
    api_url: str
    token: str
    s3_endpoint: str
    s3_region: str
    s3_access_key: str
    s3_secret_key: str
    bucket_uploads: str
    bucket_derived: str
    scratch: Path
    consumer: str
    block_ms: int = 5000
    claim_idle_ms: int = 15 * 60 * 1000
    max_deliveries: int = 5

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
        )


class Service:
    def __init__(self, r: redis.Redis, jobs: Jobs, consumer: str, block_ms: int = 5000,
                 claim_idle_ms: int = 15 * 60 * 1000, max_deliveries: int = 5):
        self.r = r
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

    def process(self, entry_id: str, fields: dict) -> str:
        if self._deliveries(entry_id) > self.max_deliveries:
            self.r.xadd(DEAD, {"entry_id": entry_id, **fields}, maxlen=10000, approximate=True)
            self.r.xack(STREAM, GROUP, entry_id)
            log.error("event dead-lettered entry=%s", entry_id)
            return "dead"
        event: object = None
        try:
            event = json.loads(fields.get("event", "{}"))
            outcome = self.jobs.handle(event)
        except PERMANENT as err:
            outcome = f"permanent:{type(err).__name__}"
        except Exception as err:  # عطل مؤقت (تخزين، شبكة، 5xx): يبقى معلّقًا ويُستعاد لاحقًا
            log.warning("event deferred entry=%s error=%s", entry_id, type(err).__name__)
            return f"deferred:{type(err).__name__}"
        self.r.xack(STREAM, GROUP, entry_id)
        kind = event.get("type") if isinstance(event, dict) else None
        log.info("event done entry=%s type=%s outcome=%s", entry_id, kind, outcome)
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


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format='{"level":"%(levelname)s","msg":"%(message)s","logger":"%(name)s"}')
    cfg = Config.from_env()
    cfg.scratch.mkdir(parents=True, exist_ok=True)
    storage = S3Storage(cfg.s3_endpoint, cfg.s3_region, cfg.s3_access_key, cfg.s3_secret_key, cfg.bucket_derived)
    jobs = Jobs(InternalApi(cfg.api_url, cfg.token), storage, Buckets(cfg.bucket_uploads, cfg.bucket_derived),
                cfg.scratch)
    svc = Service(redis.Redis.from_url(cfg.redis_url, decode_responses=True), jobs, cfg.consumer, cfg.block_ms,
                  cfg.claim_idle_ms, cfg.max_deliveries)

    def stop(*_):
        svc.stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("media worker started")
    svc.run()


if __name__ == "__main__":
    main()
