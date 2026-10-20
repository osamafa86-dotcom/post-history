import hashlib
import json
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import Session
from media_worker.jobs import Buckets, Jobs, contact_sheet_key, poster_key, proxy_key
from media_worker.probe import probe

SID = "5e000000-0000-4000-8000-000000000001"
MID = "4a000000-0000-4000-8000-000000000001"
BUCKETS = Buckets(uploads="uploads", derived="media")


def _setup(data: bytes, *, kind="original", state="completed", size=None, key="tus/1", has_proxy=False,
           reject_thumbnails=False):
    storage = FakeStorage()
    if key:
        storage.objects[("uploads", key)] = data
    api = FakeApi(Session(id=SID, material_id=MID, kind=kind, state=state, size_bytes=len(data) if size is None
                          else size, storage_key=key, material_has_proxy=has_proxy),
                  reject_thumbnails=reject_thumbnails)
    return api, storage, Jobs(api, storage, BUCKETS)


def _event(type_="upload.original_received", kind="original"):
    return {"type": type_, "payload": {"material_id": MID, "upload_session_id": SID, "kind": kind}}


@pytest.fixture(scope="module")
def tagged_clip(tmp_path_factory) -> bytes:
    path = synth(tmp_path_factory.mktemp("j") / "src.mov", seconds=3, start_offset=2, vfr_drop=True,
                 leaky_tags=True)
    return path.read_bytes()


def test_original_is_verified_then_proxied_from_the_same_download(tagged_clip: bytes, tmp_path: Path):
    api, storage, jobs = _setup(tagged_clip)
    assert jobs.handle(_event()) == "verified+thumbnails+proxy"
    [body] = api.verifications
    assert body["sha256"] == hashlib.sha256(tagged_clip).hexdigest()
    assert body["size_bytes"] == len(tagged_clip)
    assert body["head_sha256"] == hashlib.sha256(tagged_clip[:1 << 20]).hexdigest()
    t = body["technical"]
    assert t["start_pts_us"] == 2_000_000 and t["vfr"] and t["video_codec"] == "h264"
    for value in LEAKY_TAGS.values():
        assert value not in json.dumps(body)

    key = proxy_key(MID, FakeApi.FILE_ID)
    assert key.startswith(f"derived/{MID}/{FakeApi.FILE_ID}/")
    thumbs = [("media", poster_key(MID, FakeApi.FILE_ID)), ("media", contact_sheet_key(MID, FakeApi.FILE_ID))]
    assert storage.puts == [*thumbs, ("media", key)]
    (tf, t), (fid, d) = api.derivatives
    assert t["kind"] == "thumbnail" and t["storage_key"] == thumbs[0][1] and t["technical"]["height"] == 360
    assert fid == FakeApi.FILE_ID and d["kind"] == "proxy" and d["technical"]["height"] == 360
    for _, k in thumbs:
        jpg = storage.objects[("media", k)]
        assert jpg[:3] == b"\xff\xd8\xff" and b"Exif" not in jpg
        for value in LEAKY_TAGS.values():
            assert value.encode() not in jpg
    out = tmp_path / "p.mp4"
    out.write_bytes(storage.objects[("media", key)])
    assert probe(out).start_pts_us == 2_000_000
    # الأصل كما هو
    assert storage.objects[("uploads", "tus/1")] == tagged_clip


def test_redelivery_after_full_success_is_skipped(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip)
    jobs.handle(_event())
    assert jobs.handle(_event()) == "skip:verified"
    assert len(api.verifications) == 1 and len(storage.puts) == 3


def test_redelivery_after_proxy_failure_resumes_with_replayed_verification(tagged_clip: bytes, monkeypatch):
    api, storage, jobs = _setup(tagged_clip)
    import media_worker.jobs as jobs_mod

    def boom(*a, **k):
        raise RuntimeError("encoder died")

    monkeypatch.setattr(jobs_mod, "make_proxy", boom)
    with pytest.raises(RuntimeError):
        jobs.handle(_event())
    # المصغّرات سبقت النسخة الخفيفة؛ الاستئناف يكمل النسخة وحدها
    assert api.session.state == "verified" and len(storage.puts) == 2
    monkeypatch.undo()
    assert jobs.handle(_event()) == "verified+proxy"
    assert len(api.verifications) == 2 and api.verifications[0]["sha256"] == api.verifications[1]["sha256"]


def test_proxy_upload_is_not_reverified(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, kind="proxy")
    assert jobs.handle(_event("upload.proxy_received", kind="proxy")) == "verified"
    assert storage.puts == []
    assert jobs.handle(_event("upload.proxy_received", kind="proxy")) == "skip:verified"


def test_no_worker_proxy_when_phone_sent_one(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, has_proxy=True)
    assert jobs.handle(_event()) == "verified+thumbnails"
    assert [k for _, k in storage.puts] == [poster_key(MID, FakeApi.FILE_ID), contact_sheet_key(MID, FakeApi.FILE_ID)]
    assert [d["kind"] for _, d in api.derivatives] == ["thumbnail"]


def test_unregistered_thumbnails_do_not_block_the_proxy(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, reject_thumbnails=True)
    assert jobs.handle(_event()) == "verified+thumbnails-unregistered+proxy"
    assert len(storage.puts) == 3 and [d["kind"] for _, d in api.derivatives] == ["proxy"]


def test_thumbnail_failure_does_not_block_the_proxy(tagged_clip: bytes, monkeypatch):
    import media_worker.jobs as jobs_mod

    def boom(*a, **k):
        raise ValueError("no frame")

    monkeypatch.setattr(jobs_mod, "poster", boom)
    api, storage, jobs = _setup(tagged_clip)
    assert jobs.handle(_event()) == "verified+thumbnails-failed+proxy"


def test_audio_original_has_no_proxy(tmp_path: Path):
    api, storage, jobs = _setup(synth(tmp_path / "a.m4a", video=False).read_bytes())
    assert jobs.handle(_event()) == "verified"
    assert storage.puts == []


def test_size_mismatch_is_invalid_without_hash(tagged_clip: bytes):
    api, _, jobs = _setup(tagged_clip, size=len(tagged_clip) + 1)
    assert jobs.handle(_event()) == "invalid_file"
    assert api.verifications == [{"result": "invalid_file"}]


def test_unreadable_media_is_invalid_without_hash():
    api, _, jobs = _setup(b"definitely not media" * 1000)
    assert jobs.handle(_event()) == "invalid_file"
    assert api.verifications == [{"result": "invalid_file"}]


def test_missing_object_is_storage_error():
    api, storage, jobs = _setup(b"x" * 10)
    storage.objects.clear()
    assert jobs.handle(_event()) == "storage_error"
    assert api.verifications == [{"result": "storage_error"}]


@pytest.mark.parametrize("event", [
    {"type": "material.created", "payload": {"material_id": MID}},
    {"type": "upload.verified", "payload": {"material_id": MID, "upload_session_id": SID, "kind": "original"}},
    {},
])
def test_unrelated_events_ignored(event: dict):
    api, _, jobs = _setup(b"x")
    assert jobs.handle(event) == "ignored"
    assert api.verifications == []
