"""مقاطع اصطناعية للاختبار بـ PyAV وحده (لا ffmpeg في الصورة): صورة ثابتة ونغمة يبدأ صوتها بعد الصورة بإزاحة معروفة."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import numpy as np


def clip(path: Path, seconds: float = 3.0, audio_delay_s: float = 0.3, rate: int = 16000) -> Path:
    import av

    with av.open(str(path), "w", format="mp4") as out:
        v = out.add_stream("mpeg4", rate=10)
        v.width, v.height, v.pix_fmt = 64, 48, "yuv420p"
        a = out.add_stream("aac", rate=rate, layout="mono")
        a.time_base = Fraction(1, rate)
        for i in range(int(seconds * 10)):
            frame = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), np.uint8), format="rgb24")
            frame.pts = i
            out.mux(v.encode(frame))
        out.mux(v.encode(None))
        t = np.arange(int(seconds * rate)) / rate
        tone = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        step, pts = 1024, int(audio_delay_s * rate)
        for i in range(0, len(tone), step):
            frame = av.AudioFrame.from_ndarray(tone[None, i:i + step], format="flt", layout="mono")
            frame.sample_rate, frame.pts = rate, pts + i
            out.mux(a.encode(frame))
        out.mux(a.encode(None))
    return path
