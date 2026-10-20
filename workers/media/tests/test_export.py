"""حزمة التصدير: الأصل كما هو، بصمة لكل ملف، ملف جانبي بلا بيانات كاشفة، وتسلسل تقرؤه أداة مفتوحة
(OpenTimelineIO بمحوّلَي fcpx_xml وcmx_3600) لا مجرد ادعاء."""

import hashlib
import json
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path

import opentimelineio as otio
import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi
from media_worker.export import build_package, frame_rate
from media_worker.jobs import export_key
from media_worker.probe import probe
from test_jobs import MID, _event, _setup

FID = "f0000000-0000-4000-8000-000000000001"


@pytest.fixture(scope="module")
def package(tmp_path_factory):
    d = tmp_path_factory.mktemp("exp")
    src = synth(d / "src.mov", seconds=3, rate=30, start_offset=2, leaky_tags=True)
    proxy = synth(d / "proxy.mp4", seconds=3, size="320x180")
    info = probe(src)
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    out = d / "export.zip"
    sums = build_package(out, original=src, info=info, material_id=MID, file_id=FID, sha256=sha,
                         size_bytes=src.stat().st_size, proxy=proxy)
    return out, src, info, sha, sums, d


def test_archive_holds_untouched_original_and_per_file_hashes(package):
    out, src, _, sha, sums, _ = package
    with zipfile.ZipFile(out) as zf:
        assert zf.testzip() is None
        names = zf.namelist()
        assert names == ["original.mov", "proxy.mp4", "metadata.json", "sequence.fcpxml", "sequence.edl",
                         "SHA256SUMS"]
        assert zf.getinfo("original.mov").compress_type == zipfile.ZIP_STORED
        assert zf.read("original.mov") == src.read_bytes() and sums["original.mov"] == sha
        lines = zf.read("SHA256SUMS").decode().splitlines()
        assert len(lines) == 5
        for line in lines:
            h, name = line.split("  ")
            assert hashlib.sha256(zf.read(name)).hexdigest() == h


def test_archive_is_deterministic(package, tmp_path: Path):
    out, src, info, sha, _, d = package
    again = tmp_path / "again.zip"
    build_package(again, original=src, info=info, material_id=MID, file_id=FID, sha256=sha,
                  size_bytes=src.stat().st_size, proxy=d / "proxy.mp4")
    assert again.read_bytes() == out.read_bytes()


def test_sidecar_has_no_revealing_metadata(package):
    out, _, _, sha, _, _ = package
    with zipfile.ZipFile(out) as zf:
        meta = json.loads(zf.read("metadata.json"))
        text = b"".join(zf.read(n) for n in zf.namelist() if n != "original.mov").decode(errors="replace")
    assert set(meta) == {"schema", "material_id", "file_id", "original", "technical"}
    assert meta["original"]["sha256"] == sha
    for value in LEAKY_TAGS.values():
        assert value not in text
    for key in ("location", "gps", "make", "model", "source"):
        assert key not in json.dumps(meta).lower()


def test_fcpxml_parses_with_open_tool_as_one_clip(package, tmp_path: Path):
    out, _, info, _, _, _ = package
    with zipfile.ZipFile(out) as zf:
        raw = zf.read("sequence.fcpxml").decode()
    root = ET.fromstring(raw)
    assert root.tag == "fcpxml" and root.get("version") == "1.9"
    assert root.find("resources/asset/media-rep").get("src") == "original.mov"
    tl = otio.adapters.read_from_string(raw, "fcpx_xml")
    tl = tl if isinstance(tl, otio.schema.Timeline) else tl[0]
    [clip] = tl.find_clips()
    assert abs(clip.duration().to_seconds() - info.duration_ms / 1000) < 1 / 30 + 1e-6
    assert clip.duration().rate == pytest.approx(float(frame_rate(info)))


def test_edl_parses_with_open_tool_as_one_clip(package):
    out, _, info, _, _, _ = package
    with zipfile.ZipFile(out) as zf:
        raw = zf.read("sequence.edl").decode()
    tl = otio.adapters.read_from_string(raw, "cmx_3600", rate=30)
    # حدث واحد AA/V: لقطة في مسار الفيديو وفي كل مسار صوت
    clips = tl.find_clips()
    assert {t.kind for t in tl.tracks} == {"Video", "Audio"} and all(len(t) == 1 for t in tl.tracks)
    for clip in clips:
        assert clip.name == "original.mov"
        assert abs(clip.duration().to_seconds() - info.duration_ms / 1000) < 1 / 30 + 1e-6


def test_ntsc_rate_is_rational():
    from media_worker.probe import Probe
    base = dict(duration_ms=1000, start_pts_us=0, container="mov", video_codec="h264", audio_codec=None,
                width=1, height=1, avg_frame_rate=None, vfr=False, frame_count=None, max_frame_gap_ms=None,
                has_gaps=False, rotation=0, hdr=False, bit_depth=8, audio_sample_rate=None, audio_channels=None)
    assert frame_rate(Probe(frame_rate=29.97, **base)) == Fraction(30000, 1001)
    assert frame_rate(Probe(frame_rate=25.0, **base)) == 25


def test_export_job_behind_flag(tmp_path: Path):
    data = synth(tmp_path / "a.mov", seconds=2).read_bytes()
    api, storage, jobs = _setup(data)
    assert "export" not in jobs.handle(_event())
    api, storage, jobs = _setup(data)
    jobs.enable_export = True
    assert jobs.handle(_event()).endswith("+proxy+export")
    key = export_key(MID, FakeApi.FILE_ID)
    _, body = api.derivatives[-1]
    assert body["kind"] == "export" and body["storage_key"] == key
    blob = storage.objects[("media", key)]
    assert body["sha256"] == hashlib.sha256(blob).hexdigest()
    zpath = tmp_path / "e.zip"
    zpath.write_bytes(blob)
    with zipfile.ZipFile(zpath) as zf:
        assert zf.read("original.mov") == data and "proxy.mp4" in zf.namelist()
    assert storage.objects[("uploads", "tus/1")] == data
