"""التصدير النهائي: المدة مجموع المقاطع، والاتجاه وHDR صحيحان، وبلا وسوم، والأصل لا يُمس.
دقة نقاط القص وتزامن الصوت على علامات ومضة/نغمة في `tools/render-bench/cut_export.py`."""

import hashlib
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, rotated, synth
from media_worker.probe import probe
from media_worker.render import Segment, available_encoder, render
from test_hdr import hdr_clip


def test_two_segments_from_an_offset_vfr_original(tmp_path: Path):
    src = synth(tmp_path / "s.mov", seconds=8, size="1280x720", start_offset=3, vfr_drop=True, leaky_tags=True)
    before = hashlib.sha256(src.read_bytes()).hexdigest()
    info = probe(src)
    segs = [Segment(3_500_000, 5_000_000), Segment(7_000_000, 9_200_000)]
    out = render(src, tmp_path / "o.mp4", info, segs)
    assert abs(out.duration_ms - 3700) <= 70 and out.start_pts_us == 0
    assert (out.width, out.height, out.video_codec, out.audio_codec) == (1280, 720, "h264", "aac")
    data = (tmp_path / "o.mp4").read_bytes()
    for value in LEAKY_TAGS.values():
        assert value.encode() not in data
    assert hashlib.sha256(src.read_bytes()).hexdigest() == before


def test_orientation_is_applied(tmp_path: Path):
    src = rotated(synth(tmp_path / "s.mov", seconds=3, size="1280x720"), tmp_path / "r.mov", 90)
    out = render(src, tmp_path / "o.mp4", probe(src), [Segment(0, 2_000_000)])
    assert (out.width, out.height, out.rotation) == (720, 1280, 0)


def test_hdr_becomes_sdr(tmp_path: Path):
    src = hdr_clip(tmp_path / "h.mov", "arib-std-b67", seconds=3, start_offset=1.0)
    out = render(src, tmp_path / "o.mp4", probe(src), [Segment(1_200_000, 3_000_000)])
    assert not out.hdr and out.bit_depth == 8 and out.height == 1080


@pytest.mark.parametrize("segs", [[], [Segment(0, 1_000_000)], [Segment(2_000_000, 1_000_000)]])
def test_segments_outside_the_timeline_are_refused(tmp_path: Path, segs):
    src = synth(tmp_path / "s.mov", seconds=3, start_offset=1.5)
    with pytest.raises(ValueError):
        render(src, tmp_path / "o.mp4", probe(src), segs)


def test_cpu_encoder_without_nvenc():
    assert available_encoder(prefer_gpu=False) == "libx264"
