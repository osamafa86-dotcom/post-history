from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, rotated, synth
from media_worker.ffmpeg import FFMPEG, FFPROBE, run
from media_worker.probe import probe
from media_worker.thumbnails import contact_sheet, poster


def _size(path: Path) -> tuple[int, int]:
    out = run([FFPROBE, "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)], 30)
    w, h = out.decode().strip().split(",")[:2]
    return int(w), int(h)


def _black_start(path: Path, black_s: float = 1.5, seconds: int = 6) -> Path:
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={seconds}",
         "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,{black_s})'",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)], 60)
    return path


def test_poster_at_one_second_720p(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=4, size="1920x1080")
    t = poster(src, tmp_path / "poster.jpg", probe(src))
    assert t.at_s == 1.0 and (t.width, t.height) == (1280, 720) == _size(t.path)


def test_poster_skips_a_black_opening(tmp_path: Path):
    src = _black_start(tmp_path / "src.mp4")
    t = poster(src, tmp_path / "poster.jpg", probe(src))
    assert t.at_s == 2.0


def test_portrait_poster(tmp_path: Path):
    src = rotated(synth(tmp_path / "src.mp4", seconds=3, size="1920x1080"), tmp_path / "rot.mp4", 90)
    t = poster(src, tmp_path / "poster.jpg", probe(src))
    assert (t.width, t.height) == (720, 1280) == _size(t.path)


def test_contact_sheet_is_5x2(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=8, size="1920x1080", vfr_drop=True, start_offset=5)
    t = contact_sheet(src, tmp_path / "sheet.jpg", probe(src))
    assert (t.width, t.height) == (1600, 360) == _size(t.path)


def test_thumbnails_carry_no_tags(tmp_path: Path):
    src = synth(tmp_path / "src.mov", seconds=3, leaky_tags=True)
    info = probe(src)
    for t in (poster(src, tmp_path / "p.jpg", info), contact_sheet(src, tmp_path / "s.jpg", info)):
        data = t.path.read_bytes()
        assert data[:3] == b"\xff\xd8\xff" and b"Exif" not in data
        for value in LEAKY_TAGS.values():
            assert value.encode() not in data


def test_audio_only_has_no_thumbnails(tmp_path: Path):
    src = synth(tmp_path / "a.m4a", video=False)
    with pytest.raises(ValueError):
        poster(src, tmp_path / "p.jpg", probe(src))
