"""ملفات اصطناعية يولّدها FFmpeg؛ لا ملفات عينة حقيقية في المستودع ولا في CI."""

from __future__ import annotations

from pathlib import Path

import pytest

from media_worker.ffmpeg import FFMPEG, run

# وسوم بصيغة iPhone تحمل إحداثيات وطراز الجهاز؛ يجب ألا تظهر في أي مخرج
LEAKY_TAGS = {
    # قيم غير واقعية عمدًا كما في أدوات القبول
    "com.apple.quicktime.location.ISO6709": "+00.0001+000.0001+000.000/",
    "com.apple.quicktime.make": "TestMaker",
    "com.apple.quicktime.model": "TestPhone 1",
}

STREAM_TAGS = {"location": "+00.0002+000.0002/", "comment": "stream-level-device-serial-0000"}


def synth(path: Path, *, seconds: float = 4, size: str = "640x360", rate: int = 30, vfr_drop: bool = False,
          gap: tuple[float, float] | None = None, start_offset: float = 0.0, audio: bool = True,
          video: bool = True, leaky_tags: bool = False, stream_tags: bool = False) -> Path:
    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    if video:
        args += ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}"]
    if video:
        conds = []
        if vfr_drop:
            # يسقط إطارًا من كل سبعة: فواصل غير منتظمة كما في تسجيل الهواتف
            conds.append("not(eq(mod(n,7),3))")
        if gap:
            conds.append(f"not(between(t,{gap[0]},{gap[1]}))")
        if conds:
            args += ["-vf", f"select='{'*'.join(conds)}'", "-fps_mode", "vfr"]
        args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio:
        args += ["-c:a", "aac"]
    if start_offset:
        args += ["-output_ts_offset", str(start_offset)]
    if leaky_tags:
        args += ["-movflags", "use_metadata_tags"]
        for k, v in LEAKY_TAGS.items():
            args += ["-metadata", f"{k}={v}"]
    if stream_tags:
        for k, v in STREAM_TAGS.items():
            args += ["-metadata:s:v:0", f"{k}={v}"]
    args.append(str(path))
    run(args, timeout_s=120)
    return path


def rotated(src: Path, dst: Path, degrees: int) -> Path:
    """نسخة بمصفوفة عرض (كما يسجّل الهاتف عموديًا) دون إعادة ترميز."""
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-display_rotation", str(degrees),
         "-i", str(src), "-c", "copy", str(dst)], timeout_s=60)
    return dst


@pytest.fixture(scope="session")
def basic_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return synth(tmp_path_factory.mktemp("clips") / "basic.mp4")
