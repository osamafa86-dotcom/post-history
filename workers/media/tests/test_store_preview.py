"""معاينة المتجر: ملف جديد منخفض الدقة بعلامة مائية محروقة، بلا وسوم، من الأصل المتحقق عند الإدراج، والأصل لا يُمس."""

import hashlib
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import FileRef, Session
from media_worker.ffmpeg import FFMPEG, run
from media_worker.jobs import Buckets, Jobs, store_preview_key
from media_worker.probe import probe
from media_worker.watermark import offsets

KEY = b"test-only-watermark-key-0123456789"

MID = "4a000000-0000-4000-8000-000000000002"
BUCKETS = Buckets(uploads="uploads", derived="media")


def _setup(data: bytes, sha: str | None = None):
    storage = FakeStorage()
    storage.objects[("uploads", "orig/1")] = data
    api = FakeApi(Session(id="5e000000-0000-4000-8000-000000000002", material_id=MID, kind="original",
                          state="verified", size_bytes=len(data), storage_key="orig/1", material_has_proxy=True))
    api.original = FileRef(file_id=FakeApi.FILE_ID, material_id=MID, storage_key="orig/1", size_bytes=len(data),
                           sha256=sha or hashlib.sha256(data).hexdigest())
    return api, storage, Jobs(api, storage, BUCKETS, enable_store_preview=True, watermark_key=KEY)


def _listed(state="listed"):
    return {"type": "catalog.listing_changed", "aggregate_type": "listing",
            "payload": {"listing_id": "1a000000-0000-4000-8000-000000000001", "material_id": MID,
                        "material_version": 1, "state": state,
                        "source_file_id": FakeApi.FILE_ID}}


def _gray_frame(path: Path, at: float, size: str) -> bytes:
    return run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", str(at), "-i", str(path),
                "-frames:v", "1", "-vf", f"scale={size},format=gray", "-f", "rawvideo", "-"], timeout_s=60)


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> Path:
    return synth(tmp_path_factory.mktemp("sp") / "src.mov", seconds=3, size="1280x720", start_offset=2,
                 leaky_tags=True)


def test_listing_builds_a_low_res_watermarked_tagless_preview(clip: Path, tmp_path: Path):
    data = clip.read_bytes()
    api, storage, jobs = _setup(data)
    assert jobs.handle(_listed()) == "store-preview"
    key = store_preview_key(MID, FakeApi.FILE_ID)
    (fid, body), = api.derivatives
    blob = storage.objects[("media", key)]
    assert fid == FakeApi.FILE_ID and body["kind"] == "watermarked_preview" and body["storage_key"] == key
    assert body["sha256"] == hashlib.sha256(blob).hexdigest()
    out = tmp_path / "p.mp4"
    out.write_bytes(blob)
    got = probe(out)
    assert got.height == 360 and got.video_codec == "h264" and got.start_pts_us == 2_000_000
    for value in LEAKY_TAGS.values():
        assert value.encode() not in blob
    # العلامة محروقة في الصورة: الإطار يختلف بوضوح عن تصغير الأصل نفسه بلا علامة
    a, b = _gray_frame(out, 2.5, "640:360"), _gray_frame(clip, 2.5, "640:360")
    assert sum(abs(x - y) for x, y in zip(a, b)) / len(a) > 15
    # الشبكة معتمة: البكسل نفسه ثابت اللون في إطارين مختلفي المحتوى، على ربع الإطار على الأقل، فما تحته لا يُستعاد
    c = _gray_frame(out, 0.5, "640:360")
    # 235 بمدى التلفاز يصير 255 في الرمادي كامل المدى
    opaque = sum(1 for x, y in zip(a, c) if x >= 245 and y >= 245)
    assert opaque / len(a) > 0.25
    assert storage.objects[("uploads", "orig/1")] == data


def test_redelivery_reregisters_the_stored_preview(clip: Path):
    api, storage, jobs = _setup(clip.read_bytes())
    jobs.handle(_listed())
    assert jobs.handle(_listed()) == "store-preview-existing"
    assert len(storage.puts) == 1 and api.derivatives[0][1]["sha256"] == api.derivatives[1][1]["sha256"]


def test_original_that_does_not_match_its_hash_is_refused(clip: Path):
    api, storage, jobs = _setup(clip.read_bytes(), sha="0" * 64)
    with pytest.raises(ValueError):
        jobs.handle(_listed())
    assert storage.puts == []


@pytest.mark.parametrize("state", ["draft", "suspended"])
def test_only_listed_builds(clip: Path, state: str):
    api, storage, jobs = _setup(clip.read_bytes())
    assert jobs.handle(_listed(state)) == "ignored"


def test_behind_flag(clip: Path):
    api, storage, jobs = _setup(clip.read_bytes())
    jobs.enable_store_preview = False
    assert jobs.handle(_listed()) == "ignored" and storage.puts == []


def test_grid_offset_is_secret_and_per_material():
    m2 = "4a000000-0000-4000-8000-000000000003"
    assert offsets(KEY, MID) == offsets(KEY, MID)
    assert len({offsets(KEY, MID), offsets(KEY, m2), offsets(b"another-key-0123456789", MID)}) == 3
    with pytest.raises(ValueError):
        offsets(b"short", MID)


def test_missing_key_refuses_to_build(clip: Path):
    api, storage, jobs = _setup(clip.read_bytes())
    jobs.watermark_key = b""
    with pytest.raises(ValueError):
        jobs.handle(_listed())
    assert storage.puts == []
