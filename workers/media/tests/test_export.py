"""حزمة التصدير: نسخة من الأصل بنسخ التيارات منزوعة البيانات الوصفية (لا الأصل نفسه)، بصمة لكل ملف، ملف جانبي بلا
بيانات كاشفة، وتسلسل تقرؤه أداة مفتوحة (OpenTimelineIO بمحوّلَي fcpx_xml وcmx_3600) لا مجرد ادعاء."""

import hashlib
import json
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path

import opentimelineio as otio
import pytest

from conftest import LEAKY_TAGS, STREAM_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import FileRef, Session
from media_worker.export import build_package, frame_rate, strip_metadata
from media_worker.ffmpeg import FFMPEG, run
from media_worker.jobs import Buckets, Jobs, export_key, proxy_key
from media_worker.probe import probe
from test_jobs import MID, _event, _setup

FID = "f0000000-0000-4000-8000-000000000001"
# مسار ترجمة يحمل إحداثيات وطراز جهاز، كما تحمل الهواتف مسار بيانات زمنية للموقع
SUB_LEAK = "GPS +00.0003+000.0003 TestPhone serial 0000"
LEAKS = [*LEAKY_TAGS.values(), SUB_LEAK]


def _leaky_original(d: Path, ext: str = "mov") -> Path:
    """mov: وسوم QuickTime العامة (موقع وطراز) ومسار ترجمة. mkv: والوسوم على مستوى المسار، لأن mov لا يكتبها."""
    base = synth(d / f"base.{ext}", seconds=3, rate=30, start_offset=2, leaky_tags=True, stream_tags=True)
    srt = d / "leak.srt"
    srt.write_text(f"1\n00:00:00,000 --> 00:00:02,000\n{SUB_LEAK}\n")
    src = d / f"src.{ext}"
    sub = ["-c:s", "mov_text", "-movflags", "use_metadata_tags"] if ext == "mov" else ["-c:s", "srt"]
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(base), "-i", str(srt),
         "-map", "0", "-map", "1", "-c", "copy", *sub, "-map_metadata", "0", str(src)], timeout_s=60)
    data = src.read_bytes()
    planted = LEAKS + (list(STREAM_TAGS.values()) if ext == "mkv" else [])
    assert all(v.encode() in data for v in planted), "the planted tags must be in the original"
    return src


def _packets(path: Path) -> bytes:
    """بصمة كل إطار مفكوك وكل حزمة صوت: تطابقها يثبت أن الصورة لم يُعَد ترميزها (حذف وحدات SEI يغيّر الحزم لا
    الإطارات) وأن الصوت نُسخ كما هو."""
    video = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
                 "-map", "0:v:0", "-f", "framemd5", "-"], timeout_s=60)
    audio = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
                 "-map", "0:a:0", "-c", "copy", "-f", "framemd5", "-"], timeout_s=60)
    return b"".join(l for l in (video + audio).splitlines(True) if not l.startswith(b"#"))


@pytest.fixture(scope="module")
def package(tmp_path_factory):
    d = tmp_path_factory.mktemp("exp")
    src = _leaky_original(d)
    proxy = synth(d / "proxy.mp4", seconds=3, size="320x180")
    info = probe(src)
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    out = d / "export.zip"
    sums = build_package(out, original=src, info=info, material_id=MID, file_id=FID, sha256=sha,
                         size_bytes=src.stat().st_size, proxy=proxy)
    return out, src, info, sha, sums, d


def test_archive_holds_a_stripped_copy_not_the_original(package):
    out, src, info, sha, sums, d = package
    with zipfile.ZipFile(out) as zf:
        assert zf.testzip() is None
        names = zf.namelist()
        assert names == ["clip.mov", "proxy.mp4", "metadata.json", "sequence.fcpxml", "sequence.edl", "SHA256SUMS"]
        assert zf.getinfo("clip.mov").compress_type == zipfile.ZIP_STORED
        clip = zf.read("clip.mov")
    assert sums["clip.mov"] != sha and hashlib.sha256(src.read_bytes()).hexdigest() == sha  # الأصل لم يُمس
    (d / "clip.mov").write_bytes(clip)
    # نسخ تيارات بلا ترميز: كل حزمة فيديو وصوت مطابقة، و start_pts محفوظ
    assert _packets(d / "clip.mov") == _packets(src)
    got = probe(d / "clip.mov")
    assert got.start_pts_us == info.start_pts_us and (got.width, got.height) == (info.width, info.height)


def test_no_revealing_metadata_in_any_archived_file(package):
    out = package[0]
    with zipfile.ZipFile(out) as zf:
        for name in zf.namelist():
            data = zf.read(name)
            for value in LEAKS:
                assert value.encode() not in data, (name, value)


def test_stream_level_tags_and_extra_tracks_are_dropped(tmp_path: Path):
    src = _leaky_original(tmp_path, "mkv")
    out = tmp_path / "clip.mkv"
    strip_metadata(src, out)
    data = out.read_bytes()
    for value in [*LEAKS, *STREAM_TAGS.values()]:
        assert value.encode() not in data, value
    assert _packets(out) == _packets(src) and src.read_bytes() != data


def test_per_file_hashes(package):
    out = package[0]
    with zipfile.ZipFile(out) as zf:
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


def test_sidecar_carries_no_original_digest(package):
    out, src, _, sha, _, _ = package
    with zipfile.ZipFile(out) as zf:
        meta = json.loads(zf.read("metadata.json"))
        # بصمة الأصل الخام لا تغادر المنصة (ADR 0060)، في أي ملف من الحزمة
        for name in zf.namelist():
            data = zf.read(name)
            assert sha.encode() not in data and bytes.fromhex(sha) not in data, name
    assert set(meta) == {"schema", "material_id", "file_id", "media", "technical"}
    assert meta["media"] == "clip.mov"
    for key in ("location", "gps", "make", "model", "source"):
        assert key not in json.dumps(meta).lower()


def test_fcpxml_parses_with_open_tool_as_one_clip(package, tmp_path: Path):
    out, _, info, _, _, _ = package
    with zipfile.ZipFile(out) as zf:
        raw = zf.read("sequence.fcpxml").decode()
    root = ET.fromstring(raw)
    assert root.tag == "fcpxml" and root.get("version") == "1.9"
    assert root.find("resources/asset/media-rep").get("src") == "clip.mov"
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
        assert clip.name == "clip.mov"
        assert abs(clip.duration().to_seconds() - info.duration_ms / 1000) < 1 / 30 + 1e-6


def test_ntsc_rate_is_rational():
    from media_worker.probe import Probe
    base = dict(duration_ms=1000, start_pts_us=0, container="mov", video_codec="h264", audio_codec=None,
                width=1, height=1, avg_frame_rate=None, vfr=False, frame_count=None, max_frame_gap_ms=None,
                has_gaps=False, rotation=0, hdr=False, bit_depth=8, audio_sample_rate=None, audio_channels=None)
    assert frame_rate(Probe(frame_rate=29.97, **base)) == Fraction(30000, 1001)
    assert frame_rate(Probe(frame_rate=25.0, **base)) == 25


def _export_setup(data: bytes, *, proxy: bytes | None = None, state: str = "verified"):
    storage = FakeStorage()
    storage.objects[("uploads", "orig/1")] = data
    if proxy is not None:
        storage.objects[("media", proxy_key(MID, FakeApi.FILE_ID))] = proxy
    api = FakeApi(Session(id="5e000000-0000-4000-8000-000000000003", material_id=MID, kind="original",
                          state="verified", size_bytes=len(data), storage_key="orig/1", material_has_proxy=True))
    api.original = FileRef(file_id=FakeApi.FILE_ID, material_id=MID, storage_key="orig/1", size_bytes=len(data),
                           sha256=hashlib.sha256(data).hexdigest(), kind="original", state=state)
    return api, storage, Jobs(api, storage, Buckets(uploads="uploads", derived="media"), enable_export=True)


def _requested():
    return {"type": "export.requested", "aggregate_type": "material",
            "payload": {"material_id": MID, "source_file_id": FakeApi.FILE_ID,
                        "requested_by": "0b000000-0000-4000-8000-000000000001"}}


def test_export_is_built_on_request_not_at_ingest(tmp_path: Path):
    data = synth(tmp_path / "a.mov", seconds=2).read_bytes()
    api, storage, jobs = _setup(data)
    jobs.enable_export = True
    assert "export" not in jobs.handle(_event())
    proxy = synth(tmp_path / "p.mp4", seconds=2, size="320x240").read_bytes()
    api, storage, jobs = _export_setup(data, proxy=proxy)
    assert jobs.handle(_requested()) == "export"
    key = export_key(MID, FakeApi.FILE_ID)
    (fid, body), = api.derivatives
    assert fid == FakeApi.FILE_ID and body["kind"] == "export" and body["storage_key"] == key
    assert body["mime_type"] == "application/zip" and body["technical"]["video_codec"] == "h264"
    blob = storage.objects[("media", key)]
    assert body["sha256"] == hashlib.sha256(blob).hexdigest()
    zpath = tmp_path / "e.zip"
    zpath.write_bytes(blob)
    with zipfile.ZipFile(zpath) as zf:
        assert zf.namelist()[0] == "clip.mov" and zf.read("proxy.mp4") == proxy
        assert zf.read("clip.mov") != data
    assert storage.objects[("uploads", "orig/1")] == data


def test_export_redelivery_reregisters_the_stored_package(tmp_path: Path):
    api, storage, jobs = _export_setup(synth(tmp_path / "a.mov", seconds=2).read_bytes())
    assert jobs.handle(_requested()) == "export"
    assert jobs.handle(_requested()) == "export-existing"
    assert len(storage.puts) == 1 and api.derivatives[0][1] == api.derivatives[1][1]


def test_export_behind_flag_and_only_from_a_verified_original(tmp_path: Path):
    data = synth(tmp_path / "a.mov", seconds=2).read_bytes()
    api, storage, jobs = _export_setup(data)
    jobs.enable_export = False
    assert jobs.handle(_requested()) == "ignored"
    api, storage, jobs = _export_setup(data, state="received")
    with pytest.raises(ValueError):
        jobs.handle(_requested())
    assert storage.puts == []


@pytest.mark.parametrize("hevc", [False, True], ids=["h264", "hevc-hlg"])
def test_in_band_sei_is_removed_and_hdr_survives(tmp_path: Path, hevc: bool):
    # x264 وx265 يكتبان رسالة SEI user_data_unregistered بنص اسم البرنامج وخياراته: نص حر داخل التيار نفسه
    from test_hdr import hdr_clip
    src = hdr_clip(tmp_path / "h.mov", "arib-std-b67", seconds=2) if hevc else synth(tmp_path / "s.mov", seconds=2)
    marker = b"x265 (build" if hevc else b"x264 - core"
    assert marker in src.read_bytes()
    out = tmp_path / "clip.mov"
    strip_metadata(src, out)
    assert marker not in out.read_bytes()
    assert _packets(out) == _packets(src) and probe(out).hdr is hevc
