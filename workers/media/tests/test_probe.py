import json
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, rotated, synth
from media_worker.probe import InvalidMediaError, probe


def test_constant_rate_clip(basic_clip: Path):
    p = probe(basic_clip)
    assert p.video_codec == "h264" and p.audio_codec == "aac"
    assert (p.width, p.height) == (640, 360)
    assert p.frame_rate == 30 and not p.vfr and not p.has_gaps
    assert p.frame_count == 120
    assert abs(p.duration_ms - 4000) <= 50
    assert p.start_pts_us == 0
    assert p.audio_sample_rate == 48000


def test_variable_rate_and_gap_detected(tmp_path: Path):
    p = probe(synth(tmp_path / "vfr.mp4", vfr_drop=True, gap=(1.5, 2.0)))
    assert p.vfr
    assert p.has_gaps and p.max_frame_gap_ms >= 500
    assert p.avg_frame_rate < p.frame_rate


def test_start_pts_is_video_start_not_container_start(tmp_path: Path):
    # AAC يبدأ قبل الفيديو بإطار التهيئة؛ مرجع القص هو بداية الفيديو
    p = probe(synth(tmp_path / "offset.mp4", start_offset=10))
    assert p.start_pts_us == 10_000_000


def test_audio_only(tmp_path: Path):
    p = probe(synth(tmp_path / "voice.m4a", video=False))
    assert p.video_codec is None and p.frame_count is None and p.width is None
    assert p.audio_codec == "aac"


def test_rotation(tmp_path: Path, basic_clip: Path):
    p = probe(rotated(basic_clip, tmp_path / "rot.mp4", 90))
    assert p.rotation in (90, 270)


def test_tags_never_leave_probe(tmp_path: Path):
    p = probe(synth(tmp_path / "tags.mov", leaky_tags=True))
    dumped = json.dumps(p.to_dict())
    for value in LEAKY_TAGS.values():
        assert value not in dumped


@pytest.mark.parametrize("content", [b"", b"not a video at all" * 100])
def test_invalid_files_rejected(tmp_path: Path, content: bytes):
    f = tmp_path / "bad.mp4"
    f.write_bytes(content)
    with pytest.raises(InvalidMediaError):
        probe(f)


HLS_READS_LOCAL_FILE = b"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n"
CONCAT_READS_LOCAL_FILE = b"ffconcat version 1.0\nfile '/etc/hostname'\n"


@pytest.mark.parametrize("name", ["evil.mp4", "evil.m3u8", "source"])
@pytest.mark.parametrize("content", [HLS_READS_LOCAL_FILE, CONCAT_READS_LOCAL_FILE])
def test_playlists_and_concat_lists_are_rejected(tmp_path: Path, name: str, content: bytes):
    # ملف مرفوع يتنكر قائمة تشير إلى ملف محلي: يُرفض في probe قبل أي نسخة
    f = tmp_path / name
    f.write_bytes(content)
    with pytest.raises(InvalidMediaError):
        probe(f)


def test_child_process_gets_no_worker_secrets(monkeypatch):
    from media_worker import ffmpeg

    monkeypatch.setenv("MEDIA_WORKER_TOKEN", "x" * 40)
    out = ffmpeg.run(["env"], timeout_s=10).decode()
    assert "MEDIA_WORKER_TOKEN" not in out and "S3_SECRET_KEY" not in out


def test_truncated_file_rejected(tmp_path: Path, basic_clip: Path):
    # moov في آخر الملف (بلا faststart): قطع الذيل يجعله غير قابل للقراءة
    data = basic_clip.read_bytes()
    f = tmp_path / "trunc.mp4"
    f.write_bytes(data[: len(data) // 2])
    with pytest.raises(InvalidMediaError):
        probe(f)
