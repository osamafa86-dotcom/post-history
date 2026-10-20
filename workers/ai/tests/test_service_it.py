"""الخدمة على Redis حقيقي: مجموعة `ai` تؤكد ما تخصه دون أن تمس مجموعة `media` على الدفق نفسه (ADR 0020).
يعمل حين يُعطى `AI_IT_REDIS_URL`؛ سير `ai-worker` يشترطه بـ `AI_IT_REQUIRED=1`."""

import json
import os

import pytest
from fakes import verified_event

from ai_worker.service import GROUP, STREAM, Service

URL = os.environ.get("AI_IT_REDIS_URL")
pytestmark = pytest.mark.skipif(not URL and os.environ.get("AI_IT_REQUIRED") != "1", reason="no redis")


class Jobs:
    def __init__(self):
        self.seen = []

    def handle(self, event):
        self.seen.append(event["type"])
        return "transcribed" if event["type"] == "upload.verified" else "ignored"


@pytest.fixture
def r():
    import redis

    assert URL, "AI_IT_REDIS_URL is required"
    client = redis.Redis.from_url(URL, decode_responses=True)
    client.delete(STREAM)
    yield client
    client.delete(STREAM)


def test_ai_group_acks_its_events_and_leaves_the_media_group_alone(r):
    r.xgroup_create(STREAM, "media", id="0", mkstream=True)
    jobs = Jobs()
    svc = Service(r, jobs, "ai-1", block_ms=100)
    svc.ensure_group()
    svc.ensure_group()  # idempotent (BUSYGROUP)
    received = {"type": "upload.original_received", "payload": {"material_id": "m", "kind": "original"}}
    for ev in (received, verified_event()):
        r.xadd(STREAM, {"event_id": "1", "event": json.dumps(ev)})
    while svc.run_once():
        pass
    assert jobs.seen == ["upload.original_received", "upload.verified"]
    groups = {g["name"]: g for g in r.xinfo_groups(STREAM)}
    assert groups[GROUP]["pending"] == 0
    assert groups["media"]["pending"] == 0 and groups["media"]["last-delivered-id"] == "0-0"  # untouched


def test_a_new_ai_group_starts_at_the_end_of_the_stream(r):
    r.xadd(STREAM, {"event_id": "0", "event": json.dumps(verified_event())})
    jobs = Jobs()
    svc = Service(r, jobs, "ai-1", block_ms=100)
    svc.ensure_group()
    assert svc.run_once() == 0 and jobs.seen == []
