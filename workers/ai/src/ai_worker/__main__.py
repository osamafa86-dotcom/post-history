"""`python -m ai_worker` (الخدمة) أو `python -m ai_worker transcribe <ملف>` (تفريغ ملف محلي واحد، للقياس والتجربة)."""

import json
import sys
from pathlib import Path


def _transcribe(path: str) -> None:
    import os

    from .captions import build_cues, to_webvtt
    from .transcribe import FasterWhisperEngine

    model_dir = Path(os.environ.get("AI_MODELS_DIR", "/models")) / os.environ.get("AI_MODEL", "faster-whisper-large-v3-turbo")
    t = FasterWhisperEngine(model_dir, cpu_threads=int(os.environ.get("AI_CPU_THREADS", 0))).transcribe(Path(path))
    print(to_webvtt(build_cues(t.segments)))
    print(json.dumps({"decode_s": t.decode_s, "transcribe_s": t.transcribe_s, "duration_s": t.timing.duration_s}),
          file=sys.stderr)


if __name__ == "__main__":
    if sys.argv[1:2] == ["transcribe"] and len(sys.argv) == 3:
        _transcribe(sys.argv[2])
    else:
        from .service import main

        main()
