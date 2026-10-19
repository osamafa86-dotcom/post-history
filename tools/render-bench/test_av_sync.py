"""اختبارات أداة التزامن: الخط يحفظ التزامن، والكاشف يرى انزياحًا مصطنعًا (فلا ينجح القياس لأنه أعمى)."""

from pathlib import Path

import pytest

import av_sync
from media_worker.ffmpeg import FFMPEG, run


@pytest.mark.parametrize("case", [c for c in av_sync.CASES if c.seconds <= 10], ids=lambda c: c.name)
def test_short_cases_pass(tmp_path: Path, case: av_sync.Case):
    r = av_sync.measure(case, tmp_path)
    assert r["complete"], r
    assert r["pass"], r


def test_detector_sees_an_injected_audio_delay(tmp_path: Path):
    case = av_sync.CASES[0]
    src = tmp_path / "src.mp4"
    av_sync.make_source(case, src)
    late = tmp_path / "late.mp4"
    # الصوت نفسه متأخرًا 100 ms دون إعادة ترميز
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
         "-itsoffset", "0.1", "-i", str(src), "-map", "0:v", "-map", "1:a", "-c", "copy", str(late)], 60)
    r = av_sync.compare(src, late, 120)
    assert r["marks_source"] == r["marks_proxy"] == 5
    assert abs(r["av_offset_added_ms_max"] - 100) < 2, r
    assert abs(r["audio_mark_shift_ms_max"] - 100) < 2 and r["video_mark_shift_ms_max"] < 1, r
