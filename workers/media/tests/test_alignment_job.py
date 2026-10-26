"""المحاذاة في الخط: حين يتحقق الثاني من نسخة الهاتف والأصل يُقاس الفرق ويُسجَّل للنسخة الخفيفة، غير مانع."""

import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from fakes import FakeApi, FakeStorage
from media_worker.api import FileRef, Session
from media_worker.ffmpeg import FFPROBE, run
from media_worker.jobs import Buckets, Jobs
from test_align import original, phone_proxy

MID = "4a000000-0000-4000-8000-000000000009"
SID = "5e000000-0000-4000-8000-000000000009"
OTHER = "f0000000-0000-4000-8000-000000000099"
SKIP = 1.733


@pytest.fixture(scope="module")
def pair(tmp_path_factory) -> tuple[Path, Path, float]:
    d = tmp_path_factory.mktemp("al")
    src = original(d / "o.mov", 20, 3.2, gap=(8.0, 9.5))
    prx = phone_proxy(src, d / "p.mp4", SKIP)
    start = float(run([FFPROBE, "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", str(src)],
                      timeout_s=30))
    return src, prx, (start + SKIP) * 1000


def _setup(own: bytes, kind: str, other: bytes, other_kind: str, enable: bool = True):
    storage = FakeStorage()
    storage.objects[("uploads", "tus/own")] = own
    storage.objects[("uploads", "tus/other")] = other
    link = {"original_file_id": OTHER} if kind == "proxy" else {"proxy_file_id": OTHER}
    api = FakeApi(Session(id=SID, material_id=MID, kind=kind, state="completed", size_bytes=len(own),
                          storage_key="tus/own", material_has_proxy=kind == "proxy", **link))
    api.files[OTHER] = FileRef(file_id=OTHER, material_id=MID, storage_key="tus/other", size_bytes=len(other),
                               sha256=hashlib.sha256(other).hexdigest(), kind=other_kind, state="verified")
    return api, Jobs(api, storage, Buckets(uploads="uploads", derived="media"), enable_alignment=enable)


def _event(kind: str):
    return {"type": f"upload.{kind}_received", "payload": {"material_id": MID, "upload_session_id": SID, "kind": kind}}


def test_original_arriving_second_aligns_the_phone_proxy(pair):
    src, prx, truth = pair
    api, jobs = _setup(src.read_bytes(), "original", prx.read_bytes(), "proxy")
    assert jobs.handle(_event("original")).endswith("+proxy+thumbnails+align")
    (fid, body), = api.alignments
    # t_original = t_proxy + offset_ms
    assert fid == OTHER and body["original_file_id"] == FakeApi.FILE_ID and body["reliable"]
    assert abs(body["offset_ms"] - truth) <= 10


def test_phone_proxy_arriving_second_aligns_itself(pair):
    src, prx, truth = pair
    api, jobs = _setup(prx.read_bytes(), "proxy", src.read_bytes(), "original")
    assert jobs.handle(_event("proxy")) == "verified+align"
    (fid, body), = api.alignments
    assert fid == FakeApi.FILE_ID and body["original_file_id"] == OTHER and abs(body["offset_ms"] - truth) <= 10


def test_alignment_is_behind_its_flag_and_never_blocks(pair):
    src, prx, _ = pair
    api, jobs = _setup(prx.read_bytes(), "proxy", src.read_bytes(), "original", enable=False)
    assert jobs.handle(_event("proxy")) == "verified" and api.alignments == []
    api, jobs = _setup(prx.read_bytes(), "proxy", src.read_bytes(), "original")
    api.files[OTHER] = replace(api.files[OTHER], material_id="4a000000-0000-4000-8000-00000000000f")
    assert jobs.handle(_event("proxy")) == "verified+align-failed" and api.alignments == []
