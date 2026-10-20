"""المحرك الحقيقي على مقطع اصطناعي. يعمل حين يُعطى `AI_IT_MODEL_DIR` (أوزان faster-whisper مثبّتة البصمة)؛ وظيفة
`ai-worker` في CI تنزّل tiny وتشترطه بـ `AI_IT_REQUIRED=1` فلا يمر الاختبار متخطى."""

import json
import os
from pathlib import Path

import pytest
from media import clip

from ai_worker.captions import build_cues, to_json, to_webvtt
from ai_worker.transcribe import FasterWhisperEngine, NoAudioError, media_timing

MODEL = os.environ.get("AI_IT_MODEL_DIR")
pytestmark = pytest.mark.skipif(not MODEL and os.environ.get("AI_IT_REQUIRED") != "1", reason="no model dir")


def test_timing_reads_the_audio_offset(tmp_path):
    # the tone starts at 0.3 s; AAC adds 1024 priming samples (64 ms at 16 kHz) before it, and decode_audio keeps them,
    # so sample 0 of the decoded audio sits at 0.236 s on the media timeline
    t = media_timing(clip(tmp_path / "c.mp4", seconds=3.0, audio_delay_s=0.3))
    assert abs(t.audio_offset_s - (0.3 - 1024 / 16000)) < 0.002
    assert 2.9 < t.duration_s < 3.6


def test_no_audio_stream_is_reported(tmp_path):
    import av
    import numpy as np

    p = tmp_path / "v.mp4"
    with av.open(str(p), "w", format="mp4") as out:
        v = out.add_stream("mpeg4", rate=10)
        v.width, v.height, v.pix_fmt = 64, 48, "yuv420p"
        for i in range(5):
            f = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), np.uint8), format="rgb24")
            f.pts = i
            out.mux(v.encode(f))
        out.mux(v.encode(None))
    with pytest.raises(NoAudioError):
        media_timing(p)


def test_engine_runs_offline_and_writes_valid_drafts(tmp_path, monkeypatch):
    assert MODEL, "AI_IT_MODEL_DIR is required"
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    engine = FasterWhisperEngine(Path(MODEL), cpu_threads=2)
    t = engine.transcribe(clip(tmp_path / "c.mp4", seconds=4.0, audio_delay_s=0.5))
    for s in t.segments:  # a tone has no speech; whatever comes out stays on the media timeline
        assert s.start >= 0.5 - 0.05 and s.end <= t.timing.duration_s + 0.5
    doc = json.loads(to_json(t.segments, duration_s=t.timing.duration_s, start_pts_us=t.timing.start_pts_us,
                             engine=engine.describe, source={"file_id": "f"}))
    assert doc["status"] == "draft" and doc["engine"]["vad"] == "silero"
    assert to_webvtt(build_cues(t.segments)).startswith("WEBVTT")


def test_no_telemetry(tmp_path):
    """onnxruntime announces its telemetry on stderr at import; with the switch set it must stay silent."""
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if k != "ORT_DISABLE_TELEMETRY"}
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    code = "from ai_worker.transcribe import disable_telemetry; disable_telemetry(); from faster_whisper.vad import get_vad_model; get_vad_model()"
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    assert "telemetry" not in out.stderr.lower()
