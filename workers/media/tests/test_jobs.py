import hashlib
import json
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import Session
from media_worker.jobs import Buckets, Jobs, proxy_key
from media_worker.probe import probe

SID = "5e000000-0000-4000-8000-000000000001"
MID = "4a000000-0000-4000-8000-000000000001"
BUCKETS = Buckets(uploads="uploads", derived="media")


def _setup(data: bytes, *, kind="original", state="completed", size=None, key="u/1", has_proxy=False):
    storage = FakeStorage()
    if key:
        storage.objects[("uploads", key)] = data
    api = FakeApi(Session(id=SID, material_id=MID, kind=kind, state=state, size_bytes=len(data) if size is None
                          else size, storage_key=key, material_has_proxy=has_proxy, file_id=None))
    return api, storage, Jobs(api, storage, BUCKETS)


def _event(type_, kind="original"):
    return {"type": type_, "payload": {"material_id": MID, "upload_session_id": SID, "kind": kind}}


@pytest.fixture(scope="module")
def tagged_clip(tmp_path_factory) -> bytes:
    path = synth(tmp_path_factory.mktemp("j") / "src.mov", seconds=3, start_offset=2, vfr_drop=True,
                 leaky_tags=True)
    return path.read_bytes()


def test_verify_reports_sha256_fingerprint_and_technical(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip)
    assert jobs.handle(_event("upload.original_received")) == "verified"
    [body] = api.verifications
    assert body["sha256"] == hashlib.sha256(tagged_clip).hexdigest()
    assert body["size_bytes"] == len(tagged_clip)
    assert body["head_sha256"] == hashlib.sha256(tagged_clip[:1 << 20]).hexdigest()
    t = body["technical"]
    assert t["start_pts_us"] == 2_000_000 and t["vfr"] and t["video_codec"] == "h264"
    dumped = json.dumps(body)
    for value in LEAKY_TAGS.values():
        assert value not in dumped
    # الأصل كما هو، ولا كتابة على التخزين في التحقق
    assert storage.objects[("uploads", "u/1")] == tagged_clip and storage.puts == []


def test_redelivered_event_after_verification_is_skipped(tagged_clip: bytes):
    api, _, jobs = _setup(tagged_clip)
    jobs.handle(_event("upload.original_received"))
    assert jobs.handle(_event("upload.original_received")) == "skip:verified"
    assert len(api.verifications) == 1


def test_size_mismatch_is_invalid(tagged_clip: bytes):
    api, _, jobs = _setup(tagged_clip, size=len(tagged_clip) + 1)
    assert jobs.handle(_event("upload.original_received")) == "invalid_file"
    assert "technical" not in api.verifications[0]


def test_unreadable_media_is_invalid():
    api, _, jobs = _setup(b"definitely not media" * 1000)
    assert jobs.handle(_event("upload.proxy_received", kind="proxy")) == "invalid_file"
    assert api.verifications[0]["sha256"]


def test_missing_object_is_storage_error():
    api, storage, jobs = _setup(b"x" * 10)
    storage.objects.clear()
    assert jobs.handle(_event("upload.original_received")) == "storage_error"
    assert api.verifications == [{"result": "storage_error"}]


def test_proxy_after_verification_goes_to_derived_bucket(tagged_clip: bytes, tmp_path: Path):
    api, storage, jobs = _setup(tagged_clip)
    jobs.handle(_event("upload.original_received"))
    assert jobs.handle(_event("upload.verified")) == "proxy"
    file_id = api.session.file_id
    key = proxy_key(MID, file_id)
    assert storage.puts == [("media", key)]
    [(fid, body)] = api.derivatives
    assert fid == file_id and body["kind"] == "proxy" and body["storage_key"] == key
    assert body["technical"]["start_pts_us"] == 2_000_000 and body["technical"]["height"] == 360
    out = tmp_path / "p.mp4"
    out.write_bytes(storage.objects[("media", key)])
    assert probe(out).start_pts_us == 2_000_000
    assert storage.objects[("uploads", "u/1")] == tagged_clip


def test_no_proxy_when_phone_sent_one(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, has_proxy=True)
    jobs.handle(_event("upload.original_received"))
    assert jobs.handle(_event("upload.verified")) == "skip:has-proxy"
    assert storage.puts == [] and api.derivatives == []


def test_no_proxy_for_audio(tmp_path: Path):
    api, storage, jobs = _setup(synth(tmp_path / "a.m4a", video=False).read_bytes())
    jobs.handle(_event("upload.original_received"))
    assert jobs.handle(_event("upload.verified")) == "skip:no-video"
    assert storage.puts == []


@pytest.mark.parametrize("event", [
    {"type": "material.created", "payload": {"material_id": MID}},
    {"type": "upload.verified", "payload": {"material_id": MID, "upload_session_id": SID, "kind": "proxy"}},
    {},
])
def test_unrelated_events_ignored(event: dict):
    api, _, jobs = _setup(b"x")
    assert jobs.handle(event) == "ignored"
    assert api.verifications == []
