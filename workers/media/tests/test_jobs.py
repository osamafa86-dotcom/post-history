import hashlib
import json
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import Session
from media_worker.jobs import Buckets, Jobs, contact_sheet_key, poster_key, proxy_key, speech_key, timeline_prefix, waveform_key
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
    assert jobs.handle(_event()) == "verified+waveform+proxy+thumbnails"
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
    wave = ("media", waveform_key(MID, FakeApi.FILE_ID))
    assert storage.puts == [wave, ("media", key), *thumbs]
    (_, w), (fid, d), (tf, t) = api.derivatives
    assert w["kind"] == "audio" and json.loads(storage.objects[wave])["points_per_minute"] == 100
    assert t["kind"] == "thumbnail" and t["storage_key"] == thumbs[0][1] and t["technical"]["height"] == 360
    assert t["mime_type"] == "image/jpeg" and tf == FakeApi.FILE_ID  # مصغّرة واحدة مسجّلة للأصل
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


def test_redelivery_after_full_success_reregisters_the_stored_proxy(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip)
    jobs.handle(_event())
    first = next(d for _, d in api.derivatives if d["kind"] == "proxy")
    assert jobs.handle(_event()) == "verified+proxy-existing"
    # لا ترميز ولا رفع جديد: التسجيل المكرر مطابق فيقبله الخادم
    assert len(storage.puts) == 4 and len(api.verifications) == 2
    again = api.derivatives[-1][1]
    assert again["kind"] == "proxy" and again["sha256"] == first["sha256"] and again["storage_key"] == first["storage_key"]
    assert again["technical"]["height"] == 360


def test_redelivery_after_proxy_failure_resumes_with_replayed_verification(tagged_clip: bytes, monkeypatch):
    api, storage, jobs = _setup(tagged_clip)
    import media_worker.jobs as jobs_mod

    def boom(*a, **k):
        raise RuntimeError("encoder died")

    monkeypatch.setattr(jobs_mod, "make_proxy", boom)
    with pytest.raises(RuntimeError):
        jobs.handle(_event())
    # المصغّرات تُبنى من النسخة الخفيفة، فالاستئناف يكملهما معًا
    assert api.session.state == "verified" and len(storage.puts) == 1
    monkeypatch.undo()
    assert jobs.handle(_event()) == "verified+proxy+thumbnails"
    assert len(api.verifications) == 2 and api.verifications[0]["sha256"] == api.verifications[1]["sha256"]


def test_proxy_upload_is_not_reverified(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, kind="proxy")
    assert jobs.handle(_event("upload.proxy_received", kind="proxy")) == "verified"
    assert storage.puts == []
    assert jobs.handle(_event("upload.proxy_received", kind="proxy")) == "skip:verified"


def test_server_proxy_is_built_even_when_phone_sent_one(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, has_proxy=True)
    assert jobs.handle(_event()) == "verified+waveform+proxy+thumbnails"
    assert proxy_key(MID, FakeApi.FILE_ID) in [k for _, k in storage.puts]
    assert [d["kind"] for _, d in api.derivatives] == ["audio", "proxy", "thumbnail"]


def test_unregistered_thumbnails_do_not_block_the_proxy(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip, reject_thumbnails=True)
    assert jobs.handle(_event()) == "verified+waveform+proxy+thumbnails-unregistered"
    assert len(storage.puts) == 4 and [d["kind"] for _, d in api.derivatives] == ["audio", "proxy"]


def test_thumbnail_failure_does_not_block_the_proxy(tagged_clip: bytes, monkeypatch):
    import media_worker.jobs as jobs_mod

    def boom(*a, **k):
        raise ValueError("no frame")

    monkeypatch.setattr(jobs_mod, "poster", boom)
    api, storage, jobs = _setup(tagged_clip)
    assert jobs.handle(_event()) == "verified+waveform+proxy+thumbnails-failed"


def test_audio_original_has_no_proxy(tmp_path: Path):
    api, storage, jobs = _setup(synth(tmp_path / "a.m4a", video=False).read_bytes())
    assert jobs.handle(_event()) == "verified+waveform"
    assert [k for _, k in storage.puts] == [waveform_key(MID, FakeApi.FILE_ID)]


def test_hls_and_phash_behind_flags(tagged_clip: bytes):
    api, storage, jobs = _setup(tagged_clip)
    jobs.enable_hls = jobs.enable_phash = True
    assert jobs.handle(_event()).endswith("+proxy+thumbnails+hls+timeline")
    assert len(api.verifications[0]["perceptual_hash"]) >= 1
    keys = [k for _, k in storage.puts if "/hls/" in k]
    assert keys[0].endswith(f"{FakeApi.FILE_ID}/hls/index.m3u8") and any(k.endswith(".m4s") for k in keys)
    assert api.derivatives[-1][1]["kind"] == "hls"
    vtt = storage.objects[("media", timeline_prefix(MID, FakeApi.FILE_ID) + "thumbnails.vtt")].decode()
    sprite = storage.objects[("media", timeline_prefix(MID, FakeApi.FILE_ID) + "sprite.jpg")]
    assert vtt.startswith("WEBVTT") and "sprite.jpg#xywh=0,0,160,90" in vtt and sprite[:3] == b"\xff\xd8\xff"


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


def test_voice_note_gets_a_tagless_mono_16k_copy(tmp_path: Path):
    data = synth(tmp_path / "v.m4a", video=False, leaky_tags=True).read_bytes()
    api, storage, jobs = _setup(data, kind="voice_note")
    assert jobs.handle(_event(kind="voice_note")) == "verified+audio"
    key = speech_key(MID, FakeApi.FILE_ID)
    assert storage.puts == [("media", key)]
    (fid, body), = api.derivatives
    blob = storage.objects[("media", key)]
    assert body["kind"] == "audio" and body["storage_key"] == key
    assert body["sha256"] == hashlib.sha256(blob).hexdigest()
    out = tmp_path / "a.m4a"
    out.write_bytes(blob)
    got = probe(out)
    assert (got.audio_codec, got.audio_channels, got.audio_sample_rate, got.video_codec) == ("aac", 1, 16000, None)
    for value in LEAKY_TAGS.values():
        assert value.encode() not in blob
    assert storage.objects[("uploads", "tus/1")] == data
    # إعادة التسليم: لا ترميز ولا رفع جديد، والتسجيل نفسه
    assert jobs.handle(_event(kind="voice_note")) == "verified+audio-existing"
    assert len(storage.puts) == 1 and api.derivatives[-1][1]["sha256"] == body["sha256"]
