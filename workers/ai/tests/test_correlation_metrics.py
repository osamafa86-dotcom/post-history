"""معرّف الترابط ومقاييس العامل (ADR 0027، تعديل 2026-11-11). خادم HTTP محلي يلتقط ما يُرسل؛ لا شبكة خارجية ولا ملفات."""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fakes import FakeRedis, verified_event

from ai_worker.api import REQUEST_ID, InternalApi
from ai_worker.metrics import Metrics
from ai_worker.service import STREAM, Service


class Capture:
    """خادم محلي يرد `{}` ويحفظ كل طلب وصله: الطريقة والمسار والترويسات والجسم."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict, bytes]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.calls.append((self.command, self.path, dict(self.headers.items()), body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

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


class Jobs:
    def __init__(self, result):
        self.result = result
        self.seen: list[str | None] = []

    def handle(self, event):
        self.seen.append(REQUEST_ID.get())
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _counted(m: Metrics) -> dict:
    events = m.payload()["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]
    assert events["name"] == "ai.worker.events"
    return {tuple(a["value"]["stringValue"] for a in sorted(p["attributes"], key=lambda a: a["key"])): p["asInt"]
            for p in events["sum"]["dataPoints"]}


def test_the_internal_api_sends_the_request_id_of_the_event_and_none_outside_one(capture):
    api = InternalApi(capture.url, "t" * 40)
    api._call("POST", "/internal/media/files/none/derivatives", {})
    assert "X-Request-Id" not in capture.calls[0][2]

    token = REQUEST_ID.set("ai-" + "a" * 32)
    try:
        api._call("POST", "/internal/media/files/none/derivatives", {})
    finally:
        REQUEST_ID.reset(token)
    assert capture.calls[1][2]["X-Request-Id"] == "ai-" + "a" * 32


def test_the_service_gives_each_event_a_random_request_id_and_counts_its_outcome():
    m = Metrics(None, "ai-worker")
    fields = {"event_id": "1", "event": json.dumps(verified_event())}
    kind = verified_event()["type"]

    done = Jobs("transcribed+transcript+captions")
    Service(FakeRedis(), done, "c1", metrics=m).process("1-0", fields)
    Service(FakeRedis(), done, "c1", metrics=m).process("2-0", fields)
    assert all(re.fullmatch(r"ai-[0-9a-f]{32}", seen or "") for seen in done.seen) and done.seen[0] != done.seen[1]
    assert REQUEST_ID.get() is None, "the id does not outlive its event"

    Service(FakeRedis(), Jobs(ConnectionError("x")), "c1", metrics=m).process("3-0", fields)
    Service(FakeRedis(), Jobs(ValueError("x")), "c1", metrics=m).process("4-0", {"event_id": "4", "event": "not json"})

    # مفاتيح التسميات مرتبة: event.type ثم outcome ثم queue
    assert _counted(m) == {(kind, "done", STREAM): "2", (kind, "deferred", STREAM): "1", ("other", "dead", STREAM): "1"}


def test_metrics_reach_the_collector_when_due_and_an_unreachable_collector_never_raises(capture):
    clock = [0.0]
    m = Metrics(capture.url, "ai-worker", interval_s=30, clock=lambda: clock[0])
    m.event("events", "upload.verified", "done", 0.5)
    assert m.flush_if_due() is False, "not before the interval"
    clock[0] = 31.0
    assert m.flush_if_due() is True
    method, path, headers, body = capture.calls[0]
    assert (method, path) == ("POST", "/v1/metrics") and headers["Content-Type"] == "application/json"
    assert json.loads(body)["resourceMetrics"][0]["scopeMetrics"][0]["scope"] == {"name": "ai-worker"}

    unreachable = Metrics("http://127.0.0.1:1", "ai-worker", interval_s=0, clock=lambda: 1.0)
    assert unreachable.flush_if_due() is False
    assert Metrics(None, "ai-worker", interval_s=0, clock=lambda: 1.0).flush_if_due() is False, "no endpoint: nothing leaves the worker"
