"""نسخة الكلام من الملاحظة الصوتية: AAC أحادية 16 kHz بلا وسوم، ملف جديد للتفريغ والاستماع الخفيف.

الأصل يُقرأ فقط. `-copyts` يحفظ بداية الأصل فتبقى طوابع التفريغ على خط زمنه. المدخل مقيد بـ `INPUT_GUARD`.
"""

from __future__ import annotations

import os
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe, probe

SAMPLE_RATE = 16000


def speech_args(src: Path, dst: Path) -> list[str]:
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        *INPUT_GUARD, "-copyts", "-i", str(src),
        "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
        "-c:a", "aac", "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "32k",
        "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-movflags", "+faststart", "-f", "mp4", str(dst),
    ]


def make_speech_audio(src: Path, dst: Path, source: Probe) -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("speech audio must be a new file, never the original")
    if source.audio_codec is None:
        raise ValueError("no audio stream")
    partial = dst.with_name(dst.name + ".partial")
    try:
        run(speech_args(src, partial), max(120.0, source.duration_ms / 1000 * 2), cwd=partial.parent)
        result = probe(partial)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
