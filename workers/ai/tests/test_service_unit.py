import json
from pathlib import Path

from fakes import FakeRedis, verified_event

from ai_worker.api import ApiGone
from ai_worker.jobs import SourceNotReady
from ai_worker.service import DEAD, RETRY_ENTRY, RETRY_FIRST_S, RETRY_MAX_S, Config, Service, clean_scratch, read_manifest
from ai_worker.transcribe import NoAudioError


class Jobs:
    def __init__(self, result):
        self.result = result

    def handle(self, event):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def run(result, delivered=1, fields=None, now=1000.0, entry="1-0"):
    r = FakeRedis(delivered)
    svc = Service(r, Jobs(result), "c1", max_deliveries=5, sleep=lambda s: None, source_wait_s=3600, clock=lambda: now)
    out = svc.process(entry, fields or {"event_id": "1", "event": json.dumps(verified_event())})
    return out, r


def test_done_is_acked():
    out, r = run("transcribed+transcript+captions")
    assert out.startswith("transcribed") and r.acked == ["1-0"] and r.added == []


def test_transient_failure_stays_pending():
    out, r = run(ConnectionError("x"))
    assert out == "deferred:ConnectionError" and r.acked == []


def test_missing_source_is_parked_with_backoff_not_blocking(caplog):
    with caplog.at_level("INFO"):
        out, r = run(SourceNotReady("x"))
    assert "event parked entry=1-0 attempt=1 delay_s=2 waited_s=0.0" in caplog.text
    assert out == "retry:1" and r.acked == ["1-0"]  # off the stream: the next material is read at once
    [(member, due)] = r.zset.items()
    m = json.loads(member)
    assert due == 1000.0 + RETRY_FIRST_S and m["ai_attempt"] == 1 and m["ai_first_seen"] == 1000.0
    # later attempts back off, capped
    out, r = run(SourceNotReady("x"), fields={**m, "ai_attempt": 9}, now=1100.0, entry=RETRY_ENTRY)
    assert out == "retry:10" and list(r.zset.values()) == [1100.0 + RETRY_MAX_S] and r.acked == []


def test_source_still_missing_after_the_wait_is_recorded_as_no_source():
    fields = {"event_id": "1", "event": json.dumps(verified_event()), "ai_attempt": 7, "ai_first_seen": 1000.0}
    out, r = run(SourceNotReady("x"), fields=fields, now=1000.0 + 3600, entry=RETRY_ENTRY)
    assert out == "dead:no_source" and r.zset == {} and r.acked == []
    assert r.added[0][0] == DEAD and r.added[0][1]["reason"] == "no_source"


def test_due_retry_is_taken_before_new_stream_entries():
    r = FakeRedis()
    r.zset = {json.dumps({"event": "{}", "ai_attempt": 1}): 5.0, json.dumps({"event": "{}", "ai_attempt": 2}): 50.0}
    svc = Service(r, Jobs("x"), "c1", clock=lambda: 10.0)
    assert svc.next_entries() == [(RETRY_ENTRY, {"event": "{}", "ai_attempt": 1})]
    assert len(r.zset) == 1  # the one not yet due stays


def test_no_audio_is_acked_not_dead():
    out, r = run(NoAudioError("x"))
    assert out == "skip:no-audio" and r.acked == ["1-0"] and r.added == []


def test_gone_and_malformed_and_too_many_deliveries_are_dead_lettered():
    for result, delivered, fields, reason in [
        (ApiGone("x"), 1, None, "gone"),
        ("unused", 1, {"event": "{not json"}, "malformed_event"),
        ("unused", 6, None, "max_deliveries"),
    ]:
        out, r = run(result, delivered, fields)
        assert out == f"dead:{reason}" and r.acked == ["1-0"]
        assert r.added[0][0] == DEAD and r.added[0][1]["reason"] == reason


def test_config_repr_hides_secrets():
    cfg = Config(redis_url="redis://:redis-pass@redis:6379", api_url="http://api:3000", token="t" * 40,
                 s3_endpoint="http://minio:9000", s3_region="auto", s3_access_key="ai-worker",
                 s3_secret_key="s3-secret-value", bucket_derived="media", scratch=Path("/scratch"),
                 models_dir=Path("/models"), model="m", consumer="c1")
    text = repr(cfg)
    for secret in ("redis-pass", "t" * 40, "ai-worker", "s3-secret-value"):
        assert secret not in text


def test_clean_scratch_and_manifest(tmp_path: Path):
    (tmp_path / "job-1").mkdir()
    (tmp_path / "keep").mkdir()
    assert clean_scratch(tmp_path) == 1 and [p.name for p in tmp_path.iterdir()] == ["keep"]
    (tmp_path / "MANIFEST").write_text("m m/config.json 11\nm m/model.bin 22\nother other/model.bin 33\n")
    assert read_manifest(tmp_path, "m") == {"model": "m", "weights_sha256": "22"}
    assert read_manifest(tmp_path / "none", "m") == {"model": "m"}


def test_parking_goes_through_defer_with_2_4_8_second_delays():
    """Each delay is read back from ai:retry after Service._defer ran, not recomputed here."""
    fields = {"event_id": "1", "event": json.dumps(verified_event())}
    dues, entry, now = [], "1-0", 1000.0
    for _ in range(4):
        out, r = run(SourceNotReady("x"), fields=fields, now=now, entry=entry)
        [(member, due)] = r.zset.items()
        dues.append(due - now)
        fields, entry, now = json.loads(member), RETRY_ENTRY, due
    assert dues == [2, 4, 8, 16]
    # the cap holds however many attempts went before
    out, r = run(SourceNotReady("x"), fields={**fields, "ai_attempt": 30}, now=now, entry=RETRY_ENTRY)
    assert list(r.zset.values()) == [now + RETRY_MAX_S]


def test_deferral_log_from_the_real_storage_client_names_the_status_not_the_key(caplog):
    """A real 403 from S3Storage.head (a local server stands in for MinIO): the message and the log carry the
    method, the bucket and the status, never the derived key with its material and file ids."""
    import http.server
    import threading

    from fakes import FILE, MATERIAL

    from ai_worker.jobs import transcript_key
    from ai_worker.storage import S3Storage, StorageError

    class Forbidden(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_response(403)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Forbidden)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        s3 = S3Storage(f"http://127.0.0.1:{srv.server_port}", "auto", "k", "s", "media")
        key = transcript_key(MATERIAL, FILE)
        try:
            s3.head("media", key)
        except StorageError as e:
            err = e
        else:
            raise AssertionError("expected StorageError")
    finally:
        srv.shutdown()
    assert str(err) == "HEAD media: HTTP 403"
    with caplog.at_level("WARNING"):
        out, r = run(err)
    assert out == "deferred:StorageError" and r.acked == []
    assert "HTTP 403" in caplog.text
    for secret in (key, MATERIAL, FILE, "derived/"):
        assert secret not in caplog.text
