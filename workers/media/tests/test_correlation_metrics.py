"""معرّف الترابط ومقاييس العامل (ADR 0027، تعديل 2026-11-11). خادم HTTP محلي يلتقط ما يُرسل؛ لا شبكة خارجية ولا ملفات."""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from media_worker.api import REQUEST_ID, InternalApi
from media_worker.metrics import Metrics
from media_worker.service import Service

REDIS_URL = os.environ.get("MEDIA_IT_REDIS_URL")


class Capture:
    """خادم محلي يرد `{}` ويحفظ كل طلب وصله: الطريقة والمسار والترويسات والجسم."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict, bytes]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.calls.append((self.command, self.path, dict(self.headers.items()), body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = _handle
            do_POST = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def capture():
    server = Capture()
    yield server
    server.close()


def _points(metric: dict, kind: str) -> dict:
    return {tuple(sorted((a["key"], a["value"]["stringValue"]) for a in p["attributes"])): p for p in metric[kind]["dataPoints"]}


def test_the_internal_api_sends_the_request_id_of_the_event_and_none_outside_one(capture):
    api = InternalApi(capture.url, "t" * 40)
    api._call("GET", "/internal/media/sessions/none")
    assert "X-Request-Id" not in capture.calls[0][2]

    token = REQUEST_ID.set("media-" + "a" * 32)
    try:
        api._call("GET", "/internal/media/sessions/none")
    finally:
        REQUEST_ID.reset(token)
    assert capture.calls[1][2]["X-Request-Id"] == "media-" + "a" * 32


def test_metrics_count_events_under_a_closed_set_of_labels_and_record_their_duration():
    m = Metrics(None, "media-worker", now=lambda: 1_700_000_000.0)
    m.event("events", "upload.original_received", "done", 2.0)
    m.event("events", "upload.original_received", "done", 20.0)
    # نوع ليس بشكل أنواع الأحداث، ونتيجة خارج القائمة: لا يدخلان تسميةً كما هما
    m.event("events", "upload.original_received\nclip of a named source", "dead:InvalidMediaError", 1.0)

    scope = m.payload()["resourceMetrics"][0]
    assert scope["resource"]["attributes"] == [] and scope["scopeMetrics"][0]["scope"] == {"name": "media-worker"}
    metrics = {x["name"]: x for x in scope["scopeMetrics"][0]["metrics"]}

    events = metrics["media.worker.events"]
    assert events["sum"]["isMonotonic"] is True and events["sum"]["aggregationTemporality"] == 2
    counted = _points(events, "sum")
    done = (("event.type", "upload.original_received"), ("outcome", "done"), ("queue", "events"))
    other = (("event.type", "other"), ("outcome", "other"), ("queue", "events"))
    assert {k: p["asInt"] for k, p in counted.items()} == {done: "2", other: "1"}

    durations = _points(metrics["media.worker.event.duration"], "histogram")
    assert durations[done]["count"] == "2" and durations[done]["sum"] == pytest.approx(22.0)
    bounds = durations[done]["explicitBounds"]
    assert len(durations[done]["bucketCounts"]) == len(bounds) + 1
    assert sum(int(c) for c in durations[done]["bucketCounts"]) == 2
    assert "named source" not in json.dumps(m.payload())


def test_metrics_reach_the_collector_when_due_and_an_unreachable_collector_never_raises(capture):
    clock = [0.0]
    m = Metrics(capture.url, "media-worker", interval_s=30, clock=lambda: clock[0])
    m.event("events", "upload.proxy_received", "deferred", 0.5)
    assert m.flush_if_due() is False, "not before the interval"
    clock[0] = 31.0
    assert m.flush_if_due() is True
    method, path, headers, body = capture.calls[0]
    assert (method, path) == ("POST", "/v1/metrics") and headers["Content-Type"] == "application/json"
    assert json.loads(body)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["name"] == "media.worker.events"
    assert m.flush_if_due() is False, "one push per interval"

    unreachable = Metrics("http://127.0.0.1:1", "media-worker", interval_s=0, clock=lambda: 1.0)
    unreachable.event("events", "upload.proxy_received", "done", 0.5)
    assert unreachable.flush_if_due() is False

    off = Metrics(None, "media-worker", interval_s=0, clock=lambda: 1.0)
    off.event("events", "upload.proxy_received", "done", 0.5)
    assert off.flush_if_due() is False, "no endpoint: nothing leaves the worker"


class RecordingJobs:
    def __init__(self):
        self.seen: list[str | None] = []

    def handle(self, event: dict) -> str:
        self.seen.append(REQUEST_ID.get())
        return "verified"

    def report_failure(self, event: object, result: str) -> str:
        return "reported"


@pytest.mark.skipif(not REDIS_URL, reason="needs Redis (MEDIA_IT_REDIS_URL)")
def test_the_service_gives_each_event_a_random_request_id_and_counts_its_outcome():
    import redis

    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    stream = f"media:test:{uuid.uuid4().hex}"
    jobs, metrics = RecordingJobs(), Metrics(None, "media-worker")
    try:
        svc = Service(r, jobs, "c1", block_ms=50, stream=stream, group="media-test", metrics=metrics)
        svc.ensure_group()
        event = {"id": "1", "type": "upload.original_received", "aggregate_type": "upload", "aggregate_id": str(uuid.uuid4()), "payload": {}}
        for _ in range(2):
            r.xadd(stream, {"event_id": "1", "event": json.dumps(event)})
            assert svc.run_once() == 1
    finally:
        r.delete(stream)

    assert len(jobs.seen) == 2 and jobs.seen[0] != jobs.seen[1]
    assert all(re.fullmatch(r"media-[0-9a-f]{32}", str(rid)) for rid in jobs.seen)
    assert REQUEST_ID.get() is None, "no id outside an event"
    events = {x["name"]: x for x in metrics.payload()["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]}["media.worker.events"]
    done = (("event.type", "upload.original_received"), ("outcome", "done"), ("queue", stream))
    assert _points(events, "sum")[done]["asInt"] == "2"
