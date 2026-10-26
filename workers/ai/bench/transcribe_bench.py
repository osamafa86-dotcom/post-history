"""قياس زمن التفريغ وذاكرته لمقطع واحد في الحاوية المحصّنة نفسها (الهدف runtime)، ونتيجته بمخطط measurement.json.

    python bench/transcribe_bench.py make-clip <out.mp4> <wav>...   # خارج الحاوية: كلام عام مرخّص في mp4 كالنسخة الخفيفة
    python bench/transcribe_bench.py make-voice <out.m4a> 60 <wav>...  # صوت وحده كملاحظة صوتية (BENCH_KIND=voice_note عند run)
    docker run ... ai-worker:runtime ... python /bench/transcribe_bench.py run /clip/clip.mp4 > result.json

الزمن من المحرك نفسه (فك الصوت والتفريغ، بعد تحميل النموذج)، والذاكرة ذروة cgroup للحاوية (`memory.peak`)، فتشمل
تحميل النموذج. لا نص تفريغ في الناتج.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import platform
import sys
import time
from fractions import Fraction
from pathlib import Path


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_clip(out: str, wavs: list[str], seconds: float = 120.0, rate: int = 16000, video: bool = True) -> None:
    """video=False: صوت وحده AAC أحادي 16 kHz، كـ `audio-16k.m4a` الذي يصنعه عامل الوسائط للملاحظة الصوتية."""
    import av
    import numpy as np
    import soundfile as sf

    parts, total = [], 0
    for w in wavs:
        a, sr = sf.read(w, dtype="float32")
        assert sr == rate
        parts += [a, np.zeros(int(0.4 * rate), np.float32)]
        total += len(a) + int(0.4 * rate)
        if total >= seconds * rate:
            break
    audio = np.concatenate(parts)[: int(seconds * rate)]
    assert len(audio) == int(seconds * rate), "not enough speech for the clip"
    with av.open(out, "w", format="mp4") as c:
        if video:
            v = c.add_stream("mpeg4", rate=5)
            v.width, v.height, v.pix_fmt = 64, 48, "yuv420p"
        a = c.add_stream("aac", rate=rate, layout="mono")
        a.time_base = Fraction(1, rate)
        for i in range(int(seconds * 5) if video else 0):
            f = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), np.uint8), format="rgb24")
            f.pts = i
            c.mux(v.encode(f))
        if video:
            c.mux(v.encode(None))
        for i in range(0, len(audio), 1024):
            f = av.AudioFrame.from_ndarray(audio[None, i:i + 1024], format="flt", layout="mono")
            f.sample_rate, f.pts = rate, i
            c.mux(a.encode(f))
        c.mux(a.encode(None))


def cgroup_peak_mb() -> float | None:
    for p in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(Path(p).read_text()) / 1048576, 1)
        except (OSError, ValueError):
            continue
    return None


def run(clip: str) -> None:
    from ai_worker.captions import build_cues, to_webvtt
    from ai_worker.transcribe import FasterWhisperEngine

    model = os.environ.get("AI_MODEL", "faster-whisper-large-v3-turbo")
    threads = int(os.environ.get("AI_CPU_THREADS", 0))
    started = now()
    t0 = time.perf_counter()
    engine = FasterWhisperEngine(Path(os.environ.get("AI_MODELS_DIR", "/models")) / model, cpu_threads=threads)
    load_s = time.perf_counter() - t0
    t = engine.transcribe(Path(clip))
    cues = build_cues(t.segments)
    to_webvtt(cues)
    proc_s = t.decode_s + t.transcribe_s
    cpus = os.environ.get("BENCH_CPUS", "?")
    voice = os.environ.get("BENCH_KIND") == "voice_note"
    minutes = round(t.timing.duration_s / 60)
    doc = {
        "schema_version": 1, "tool": "asr-bench", "role": "ai",
        "test_name": f"transcribe-worker-voice-note-{minutes}min-cpu" if voice else "transcribe-worker-2min-cpu",
        "started_at": started, "ended_at": now(), "result": "info",
        "device": {"platform": "server", "model": f"{os.environ.get('BENCH_CPU_MODEL', platform.processor())}, "
                                                  f"--cpus {cpus}, --memory {os.environ.get('BENCH_MEM', '?')}, CPU only",
                   "os_version": platform.platform()},
        "upload_path": "n/a",
        "file": {"duration_s": round(t.timing.duration_s, 2),
                 "codec": "aac mono 16 kHz, audio only (like audio-16k.m4a)" if voice else "aac (mp4, like proxy-480p)"},
        "provider": f"local: {engine.describe['name']} {model} ({engine.describe['compute_type']}, "
                    f"vad {engine.describe['vad']})",
        "cost_usd": 0,
        "metrics": {
            "audio_s": round(t.timing.duration_s, 2), "load_s": round(load_s, 2), "decode_s": round(t.decode_s, 2),
            "transcribe_s": round(t.transcribe_s, 2), "processing_s": round(proc_s, 2),
            "rtf_cpu": round(proc_s / t.timing.duration_s, 3), "peak_memory_mb": cgroup_peak_mb() or "not measured",
            "segments": len(t.segments), "cues": len(cues), "cpu_threads": threads or "auto",
            "network": "none (docker --network none)", "hardening": "read-only root, cap-drop ALL, no-new-privileges, uid 10002",
        },
        "notes": (f"{minutes} minute(s) of public CC-BY-4.0 read speech (FLEURS ar_eg test, the asr-bench msa-read clips "
                  "joined with 0.4 s pauses) "
                  + ("as an audio-only m4a like the media worker's voice-note audio. " if voice
                     else "in an mp4 like the server proxy. ")
                  + "Engine time only, after model load; peak memory is the container cgroup peak and includes the "
                    "load. No correspondent material."),
    }
    print(json.dumps(doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if sys.argv[1] == "make-clip":
        make_clip(sys.argv[2], sys.argv[3:])
    elif sys.argv[1] == "make-voice":  # <out.m4a> <seconds> <wav>...
        make_clip(sys.argv[2], sys.argv[4:], seconds=float(sys.argv[3]), video=False)
    elif sys.argv[1] == "run":
        run(sys.argv[2])
