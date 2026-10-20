import json

import pytest
from fakes import BUCKET, FILE, MATERIAL, FakeApi, FakeEngine, FakeStorage, verified_event

from ai_worker.jobs import Jobs, SourceNotReady, captions_key, proxy_key, transcript_key
from ai_worker.storage import S3Storage


def make(tmp_path, *, enabled=True, api=None, engine=None, with_proxy=True, **kw):
    storage = FakeStorage()
    if with_proxy:
        storage.objects[(BUCKET, proxy_key(MATERIAL, FILE))] = b"\x00" * 2048
    jobs = Jobs(api or FakeApi(), storage, engine or FakeEngine(), BUCKET, tmp_path, enabled=enabled,
                weights={"model": "m", "weights_sha256": "ab" * 32}, **kw)
    return jobs, storage, None


@pytest.mark.parametrize("event", [
    {"type": "upload.original_received", "payload": {"material_id": MATERIAL, "file_id": FILE, "kind": "original"}},
    verified_event(kind="proxy"),
    verified_event(kind="voice_note"),
    verified_event(file_id=None),
])
def test_ignores_everything_but_a_verified_original(tmp_path, event):
    jobs, storage, _ = make(tmp_path)
    assert jobs.handle(event) == "ignored"
    assert storage.puts == [] and jobs.engine.calls == 0


def test_flag_off_does_nothing(tmp_path):
    jobs, storage, _ = make(tmp_path, enabled=False)
    assert jobs.handle(verified_event()) == "ignored:disabled"
    assert storage.puts == [] and storage.heads == 0


def test_transcribes_the_proxy_and_registers_two_drafts(tmp_path):
    api = FakeApi()
    jobs, storage, _ = make(tmp_path, api=api, engine=FakeEngine(start_pts_us=40000))
    assert jobs.handle(verified_event()) == "transcribed+transcript+captions"
    keys = [(k, mime) for _, k, mime in storage.puts]
    assert keys == [(captions_key(MATERIAL, FILE), "text/vtt"), (transcript_key(MATERIAL, FILE), "application/json")]
    t, c = api.derivatives[(FILE, "transcript")], api.derivatives[(FILE, "captions")]
    assert t["technical"] == {"duration_ms": 12500, "start_pts_us": 40000, "container": "json"}
    assert c["mime_type"] == "text/vtt" and c["technical"]["container"] == "webvtt"
    doc = json.loads(storage.objects[(BUCKET, transcript_key(MATERIAL, FILE))])
    assert doc["status"] == "draft" and doc["engine"]["weights_sha256"] == "ab" * 32
    assert doc["source"] == {"file_id": FILE, "from": "proxy-480p.mp4"}
    assert list(tmp_path.iterdir()) == []  # the job directory and its copy of the proxy are gone


def test_redelivery_reuses_uploaded_files_without_a_second_transcription(tmp_path):
    api = FakeApi()
    jobs, storage, _ = make(tmp_path, api=api)
    jobs.handle(verified_event())
    puts = list(storage.puts)
    assert jobs.handle(verified_event()) == "reused+transcript+captions"
    assert jobs.engine.calls == 1 and storage.puts == puts and api.calls == 4


def test_missing_proxy_is_reported_at_once_without_blocking(tmp_path):
    # a phone-sent proxy means the media worker never writes proxy-480p.mp4 (#110 review): no wait in the job,
    # the service parks the event in ai:retry instead
    jobs, storage, _ = make(tmp_path, with_proxy=False)
    with pytest.raises(SourceNotReady):
        jobs.handle(verified_event())
    assert jobs.engine.calls == 0 and storage.puts == [] and storage.heads == 2  # transcript.json, then the proxy


def test_proxy_uploaded_after_a_first_attempt_is_used(tmp_path):
    jobs, storage, _ = make(tmp_path, with_proxy=False)
    with pytest.raises(SourceNotReady):
        jobs.handle(verified_event())
    storage.objects[(BUCKET, proxy_key(MATERIAL, FILE))] = b"\x00"
    assert jobs.handle(verified_event()).startswith("transcribed")


def test_kind_not_yet_in_the_contract_leaves_files_unregistered(tmp_path):
    jobs, storage, _ = make(tmp_path, api=FakeApi(reject_kinds=("transcript", "captions")))
    assert jobs.handle(verified_event()) == "transcribed+transcript-unregistered+captions-unregistered"
    assert len(storage.puts) == 2


def test_storage_client_writes_only_transcript_files(tmp_path):
    s3 = S3Storage("http://minio:9000", "auto", "k", "s", "media")
    f = tmp_path / "x"
    f.write_bytes(b"x")
    for bucket, key in [("media", f"derived/{MATERIAL}/{FILE}/proxy-480p.mp4"), ("uploads", transcript_key(MATERIAL, FILE)),
                        ("media", f"derived/{MATERIAL}/{FILE}/../x/transcript.json"), ("media", "tus/abc")]:
        with pytest.raises(PermissionError):
            s3.put_file(bucket, key, f, "0" * 64, "application/json")
