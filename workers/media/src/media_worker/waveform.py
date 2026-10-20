"""موجة الصوت: ذروات مطلقة مطبّعة (0–1) بنحو 100 نقطة في الدقيقة، JSON بلا وسوم ولا بيانات وصفية.

الصوت يُفك أحادي القناة 8 kHz تدفقيًا (لا يُحمَّل الملف كله في الذاكرة) بالتحصين نفسه (`INPUT_GUARD`).
"""

from __future__ import annotations

import json
import math
import subprocess
from array import array
from pathlib import Path

from . import ffmpeg
from .ffmpeg import FFMPEG, INPUT_GUARD

POINTS_PER_MINUTE = 100
RATE = 8000


def waveform(src: Path, duration_ms: int) -> dict:
    points = max(1, math.ceil(duration_ms / 60_000 * POINTS_PER_MINUTE))
    per_point = max(1, math.ceil(duration_ms / 1000 * RATE / points))
    proc = subprocess.Popen(
        [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", *INPUT_GUARD, "-i", str(src),
         "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, env=ffmpeg.CHILD_ENV,
        cwd=src.parent)
    peaks: list[int] = []
    buf, rest = array("h"), b""
    try:
        while chunk := proc.stdout.read(per_point * 2 * 64):
            data = rest + chunk
            rest = data[len(data) // 2 * 2:]
            buf.frombytes(data[: len(data) // 2 * 2])
            while len(buf) >= per_point:
                seg = buf[:per_point]
                peaks.append(max(max(seg), -min(seg)))
                del buf[:per_point]
        if buf:
            peaks.append(max(max(buf), -min(buf)))
    finally:
        proc.stdout.close()
        if proc.wait(timeout=max(60.0, duration_ms / 1000)) != 0:
            raise ffmpeg.MediaToolError("waveform decode failed")
    return {"version": 1, "points_per_minute": POINTS_PER_MINUTE, "duration_ms": duration_ms,
            "peaks": [round(p / 32768, 3) for p in peaks]}


def write_waveform(src: Path, dst: Path, duration_ms: int) -> Path:
    dst.write_text(json.dumps(waveform(src, duration_ms), separators=(",", ":")))
    return dst
