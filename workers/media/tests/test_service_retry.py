"""العطل المؤقت والمهمة الطويلة في حلقة العامل (ADR 0006، تعديل 2026-11-11)، على Redis حقيقي بدفق خاص بكل اختبار.

يعمل حين تُضبط MEDIA_IT_REDIS_URL (وظيفة `media` في CI). لا تخزين ولا ملفات: المهام وهمية، فلا أصل يُمس.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

import pytest

from media_worker.service import Service

REDIS_URL = os.environ.get("MEDIA_IT_REDIS_URL")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="needs Redis (MEDIA_IT_REDIS_URL)")
if os.environ.get("MEDIA_IT_REQUIRED") and not REDIS_URL:
    raise RuntimeError("MEDIA_IT_REQUIRED is set but MEDIA_IT_REDIS_URL is missing")  # CI لا يتجاوز الاختبار بصمت


class ScriptedJobs:
    """مهام وهمية: كل استدعاء يأخذ الخطوة التالية من القائمة (استثناء يُرمى، أو نتيجة تُعاد)."""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0

    def handle(self, event: dict) -> str:
        self.calls += 1
        step = self.script.pop(0) if self.script else "done"
        if isinstance(step, Exception):
            raise step
        return step

    def report_failure(self, event: object, result: str) -> str:
        return "reported"


class SlowJobs:
    """مهمة واحدة طويلة: تبدأ، تنتظر الإذن، ثم تنتهي. تعدّ كم مرة بدأت."""

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def handle(self, event: dict) -> str:
        self.calls += 1
        self.started.set()
        assert self.release.wait(timeout=10), "the test never released the job"
        return "done"

    def report_failure(self, event: object, result: str) -> str:
        return "reported"


@pytest.fixture
def queue():
    import redis

    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    stream, group = f"media:test:{uuid.uuid4().hex}", "media-test"
    yield r, stream, group
    r.delete(stream)


def _service(r, stream, group, jobs, consumer="c1", **kwargs) -> Service:
    svc = Service(r, jobs, consumer, block_ms=50, stream=stream, group=group, **kwargs)
    svc.ensure_group()
    return svc


def _publish(r, stream: str) -> None:
    event = {"id": "1", "type": "upload.original_received", "aggregate_type": "upload", "aggregate_id": str(uuid.uuid4()), "payload": {}}
    r.xadd(stream, {"event_id": "1", "event": json.dumps(event)})


def test_a_transient_failure_is_retried_within_seconds_not_left_for_the_claim_timeout(queue):
    r, stream, group = queue
    jobs = ScriptedJobs([ConnectionError("storage unreachable"), TimeoutError("still unreachable"), "done"])
    waits: list[float] = []
    svc = _service(r, stream, group, jobs, sleep=waits.append, claim_idle_ms=15 * 60 * 1000)
    _publish(r, stream)

    assert svc.run_once() == 1
    assert jobs.calls == 3, "retried in place until it succeeded"
    assert sum(waits) < 10, "seconds between attempts, not the 15-minute claim timeout"
    assert r.xpending(stream, group)["pending"] == 0, "acknowledged once done"
    # محاولات في المكان نفسه: التسليم واحد، فلا يقترب الحدث من حد التسليمات
    assert r.xlen(stream) == 1


def test_a_failure_that_outlasts_the_short_retries_stays_pending_for_a_later_delivery(queue):
    r, stream, group = queue
    jobs = ScriptedJobs([ConnectionError("down")] * 10)
    waits: list[float] = []
    svc = _service(r, stream, group, jobs, sleep=waits.append)
    _publish(r, stream)

    svc.run_once()
    assert jobs.calls == 4, "one attempt and three short retries"
    assert sum(waits) <= 40
    pending = r.xpending(stream, group)
    assert pending["pending"] == 1, "not acknowledged and not dead-lettered: the claim timeout redelivers it"


def test_a_job_longer_than_the_claim_timeout_is_not_taken_by_a_second_consumer(queue):
    r, stream, group = queue
    jobs = SlowJobs()
    first = _service(r, stream, group, jobs, consumer="c1", claim_idle_ms=300)
    second_jobs = ScriptedJobs([])
    second = _service(r, stream, group, second_jobs, consumer="c2", claim_idle_ms=300)
    _publish(r, stream)

    worker = threading.Thread(target=first.run_once, daemon=True)
    worker.start()
    try:
        assert jobs.started.wait(timeout=5)
        # المهمة تعمل أطول من مهلة الأخذ بأربعة أضعاف، والمستهلك الثاني يسأل طوالها
        deadline = time.monotonic() + 1.2
        taken = 0
        while time.monotonic() < deadline:
            taken += second.run_once()
        assert taken == 0, "the live job keeps its claim"
        assert second_jobs.calls == 0
    finally:
        jobs.release.set()
        worker.join(timeout=10)
    assert jobs.calls == 1, "executed once"
    assert r.xpending(stream, group)["pending"] == 0


def test_an_abandoned_job_is_still_taken_after_the_claim_timeout(queue):
    """النبض يتوقف مع صاحبه: حدث سُلِّم لمستهلك مات يأخذه غيره بعد المهلة كما كان."""
    r, stream, group = queue
    _service(r, stream, group, ScriptedJobs([]), consumer="gone")
    _publish(r, stream)
    assert r.xreadgroup(group, "gone", {stream: ">"}, count=1), "delivered to a consumer that then died"
    time.sleep(0.4)

    jobs = ScriptedJobs(["done"])
    survivor = _service(r, stream, group, jobs, consumer="c2", claim_idle_ms=300)
    assert survivor.run_once() == 1
    assert jobs.calls == 1
    assert r.xpending(stream, group)["pending"] == 0
