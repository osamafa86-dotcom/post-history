"""المحاذاة الزمنية: إزاحة معروفة بين أصل ونسخة هاتف بطوابع مصفَّرة تُقاس بخطأ أقل بكثير من 40 ms."""

from pathlib import Path

import pytest

from media_worker.align import measure_offset
from media_worker.ffmpeg import FFMPEG, FFPROBE, run

# ضجيج تقطعه بوابة غير دورية على مدى المقطع (حاصل ضرب جيوب بترددات غير متناسبة)، كالكلام: قمة ارتباط واحدة
GATE = "gt(sin(2*PI*0.71*t)*sin(2*PI*1.37*t+1)*sin(2*PI*0.29*t+2)\\,0.08)"


def original(path: Path, seconds: int, start: float, gap: tuple[float, float] | None = None) -> Path:
    vf = "select='not(eq(mod(n\\,7)\\,3))'" + (f"*not(between(t\\,{gap[0]}\\,{gap[1]}))" if gap else "")
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=30:duration={seconds}",
         "-f", "lavfi", "-i", f"aevalsrc='(random(0)-0.5)*{GATE}':s=48000:d={seconds}",
         "-vf", vf, "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
         "-output_ts_offset", str(start), str(path)], timeout_s=120)
    return path


def phone_proxy(src: Path, dst: Path, skip_s: float) -> Path:
    """نسخة 480p تبدأ بعد الأصل بـ skip_s وطوابعها مصفَّرة، كما يفعل مشفر العتاد."""
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(skip_s), "-i", str(src),
         "-vf", "scale=-2:240", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "64k",
         str(dst)], timeout_s=120)
    return dst


@pytest.mark.parametrize("start,skip", [(3.2, 0.27), (0.0, 0.0), (5.0, 1.733)])
def test_offset_is_recovered(tmp_path: Path, start: float, skip: float):
    src = original(tmp_path / "o.mov", 20, start, gap=(8.0, 9.5))
    prx = phone_proxy(src, tmp_path / "p.mp4", skip)
    r = measure_offset(prx, src)
    # زمن 0 في النسخة يقابل بداية ملف الأصل + skip: `-ss` يُعد من أصغر بداية مسار (الصوت يبدأ قبل الصورة بعينات
    # تهيئة AAC)، لا من start الاسمي
    truth = (float(run([FFPROBE, "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", str(src)],
                       timeout_s=30)) + skip) * 1000
    assert abs(r["offset_ms"] - truth) <= 10, (r, truth)
    assert r["confidence"] > 0.6 and r["needs_correction"] == (truth > 40)


def test_silence_is_refused_or_unconfident(tmp_path: Path):
    src = tmp_path / "s.mov"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=320x240:rate=30:duration=6", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=6",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(src)], timeout_s=60)
    r = measure_offset(src, src)
    assert not r["reliable"] and not r["needs_correction"]
