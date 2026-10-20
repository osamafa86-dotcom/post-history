"""التفريغ المحلي: faster-whisper (CTranslate2، int8 على المعالج) مع Silero VAD المضمّن وطوابع الكلمات.

الإعداد هو ما أوصى به `tools/asr-bench` (`docs/measurements/asr-bench/REPORT.md`). الأوزان من حجم `ai-models` للقراءة
فقط، متحقق منها بالبصمة قبل بدء العامل (ADR 0019)، ولا يُنزَّل شيء هنا: العامل بلا خروج شبكي، فالمادة لا تغادر
الحاوية أيًّا كان وسم حساسيتها.

الطوابع على خط زمن الأصل كما يشترط العقد (v0.2، `MediaDerivative`): الصفر هو `start_pts_us`، بداية مسار الفيديو كما
يقيسها عامل الوسائط (والنسخة الخفيفة تحفظها بـ `-copyts`)، أو بداية الحاوية لملف بلا فيديو. يُضاف إلى طوابع النموذج
فرق أول إطار صوت مفكوك عن هذا الصفر؛ المرجع زمن الإطار المفكوك لا `start_time` المعلن، لأنه ما تبدأ منه العينة صفر في
`decode_audio` (ومنه عينات التمهيد في AAC). صوت يبدأ قبل الصورة يعطي فرقًا سالبًا، والطوابع لا تنزل تحت الصفر.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from .captions import Segment, Word

SAMPLE_RATE = 16000


class NoAudioError(ValueError):
    """النسخة الخفيفة بلا مسار صوت: لا شيء يُفرَّغ (نهائي لهذا الملف)."""


@dataclass(frozen=True)
class MediaTiming:
    duration_s: float
    start_pts_us: int
    audio_offset_s: float


@dataclass(frozen=True)
class Transcript:
    segments: list[Segment]
    timing: MediaTiming
    decode_s: float
    transcribe_s: float


def media_timing(path: Path) -> MediaTiming:
    import av

    with av.open(str(path), metadata_errors="ignore") as c:
        audio = next((s for s in c.streams if s.type == "audio"), None)
        if audio is None:
            raise NoAudioError("no audio stream")
        video = next((s for s in c.streams if s.type == "video"), None)
        if video is not None and video.start_time is not None and video.time_base is not None:
            start_us = round(float(video.start_time * video.time_base) * 1e6)
        else:
            start_us = int(c.start_time or 0)
        audio_start_s = start_us / 1e6
        for frame in c.decode(audio):
            if frame.time is not None:
                audio_start_s = float(frame.time)
            break
        duration_s = (c.duration or 0) / 1e6
        if duration_s <= 0 and audio.duration is not None and audio.time_base is not None:
            duration_s = float(audio.duration * audio.time_base)
        return MediaTiming(duration_s=duration_s, start_pts_us=start_us,
                           audio_offset_s=audio_start_s - start_us / 1e6)


def disable_telemetry() -> None:
    """onnxruntime (Silero VAD) يرسل قياس استخدام إن لم يُطفأ. الصورة تضبط `ORT_DISABLE_TELEMETRY=1` قبل الاستيراد،
    وهذا يطفئه ثانية لمن يشغّل المحرك خارج الصورة. العامل بلا خروج شبكي، فهذا دفاع ثانٍ لا الوحيد."""
    os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    import onnxruntime

    onnxruntime.disable_telemetry_events()


class FasterWhisperEngine:
    """يُحمَّل مرة عند الإقلاع؛ كل مهمة استدعاء `transcribe` على ملف في مجلدها."""

    def __init__(self, model_dir: Path, *, compute_type: str = "int8", cpu_threads: int = 0,
                 beam_size: int = 5, vad: bool = True):
        disable_telemetry()
        from faster_whisper import WhisperModel

        if not (model_dir / "model.bin").is_file():
            raise FileNotFoundError(f"no model.bin in {model_dir}")
        self.model = WhisperModel(str(model_dir), device="cpu", compute_type=compute_type,
                                  cpu_threads=cpu_threads, local_files_only=True)
        self.beam_size = beam_size
        self.vad = vad
        self.describe = {"name": "faster-whisper", "compute_type": compute_type, "beam_size": beam_size,
                         "vad": "silero" if vad else "none", "word_timestamps": True}

    def transcribe(self, path: Path) -> Transcript:
        from faster_whisper.audio import decode_audio

        timing = media_timing(path)
        t0 = time.perf_counter()
        audio = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
        t1 = time.perf_counter()
        segments, _ = self.model.transcribe(audio, language="ar", beam_size=self.beam_size,
                                            word_timestamps=True, vad_filter=self.vad)
        off = timing.audio_offset_s

        def at(t: float) -> float:
            return max(0.0, t + off)

        out = [
            Segment(start=at(s.start), end=at(s.end), text=s.text,
                    words=tuple(Word(at(w.start), at(w.end), w.word, w.probability) for w in (s.words or [])))
            for s in segments
        ]
        return Transcript(out, timing, decode_s=t1 - t0, transcribe_s=time.perf_counter() - t1)
