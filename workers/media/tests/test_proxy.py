import json
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, rotated, synth
from media_worker.ffmpeg import FFPROBE, run
from media_worker.hashing import digest_file
from media_worker.probe import probe
from media_worker.proxy import make_proxy


def _video_pts(path: Path) -> list[float]:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
               "-of", "csv=p=0", str(path)], 60)
    return sorted(float(t.strip(",")) for t in out.decode().split())


def _keyframe_times(path: Path) -> list[float]:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags",
               "-of", "csv=p=0", str(path)], 60)
    rows = [line.split(",") for line in out.decode().split()]
    return sorted(float(r[0]) for r in rows if "K" in r[1])


def test_vfr_with_offset_keeps_every_frame_timestamp(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=6, size="1280x720", vfr_drop=True, gap=(2.0, 2.6), start_offset=10)
    before = digest_file(src)
    out = make_proxy(src, tmp_path / "proxy.mp4")
    source = probe(src)

    assert out.start_pts_us == source.start_pts_us == 10_000_000
    a, b = _video_pts(src), _video_pts(tmp_path / "proxy.mp4")
    assert len(a) == len(b)
    assert max(abs(x - y) for x, y in zip(a, b)) < 0.001
    assert abs(out.duration_ms - source.duration_ms) <= 40
    assert out.vfr and out.has_gaps
    # الأصل لم يُمس
    assert digest_file(src) == before


def test_480p_and_keyframe_every_second(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=5, size="1920x1080")
    out = make_proxy(src, tmp_path / "p.mp4")
    assert (out.width, out.height) == (854, 480)
    keys = _keyframe_times(tmp_path / "p.mp4")
    assert len(keys) >= 5
    assert max(b - a for a, b in zip(keys, keys[1:])) <= 1.01


def test_portrait_short_side_is_480(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=2, size="1920x1080")
    out = make_proxy(rotated(src, tmp_path / "rot.mp4", 90), tmp_path / "p.mp4")
    assert out.width == 480 and out.height == 854


def test_small_source_is_not_upscaled(tmp_path: Path):
    src = synth(tmp_path / "small.mp4", seconds=2, size="320x240")
    out = make_proxy(src, tmp_path / "p.mp4")
    assert (out.width, out.height) == (320, 240)


def test_proxy_drops_location_and_device_tags(tmp_path: Path):
    src = synth(tmp_path / "src.mov", seconds=2, leaky_tags=True)
    tags_in = run([FFPROBE, "-v", "error", "-show_entries", "format_tags", "-of", "json", str(src)], 30).decode()
    assert LEAKY_TAGS["com.apple.quicktime.location.ISO6709"] in tags_in  # الاختبار يرى الوسم في الأصل
    make_proxy(src, tmp_path / "p.mp4")
    dump = run([FFPROBE, "-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json",
                str(tmp_path / "p.mp4")], 30).decode()
    for value in LEAKY_TAGS.values():
        assert value not in dump
    tags = json.loads(dump)
    assert "location" not in json.dumps(tags).lower()


def test_refuses_to_overwrite_original(basic_clip: Path):
    with pytest.raises(ValueError):
        make_proxy(basic_clip, basic_clip)


def test_audio_only_has_no_video_proxy(tmp_path: Path):
    with pytest.raises(ValueError):
        make_proxy(synth(tmp_path / "a.m4a", video=False), tmp_path / "p.mp4")


def test_rerun_is_idempotent_and_leaves_no_partial(tmp_path: Path, basic_clip: Path):
    first = make_proxy(basic_clip, tmp_path / "p.mp4")
    second = make_proxy(basic_clip, tmp_path / "p.mp4")
    assert first == second
    assert sorted(p.name for p in tmp_path.iterdir()) == ["p.mp4"]
