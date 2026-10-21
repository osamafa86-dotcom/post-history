"""كشف حدود اللقطات محليًا على النسخة الخفيفة: خوارزمية `ContentDetector` من PySceneDetect على إطارات يفكّها PyAV.

- **لماذا لا تُشغَّل PySceneDetect كاملة:** واجهتاها للفيديو تحسبان الزمن من رقم الإطار ÷ المعدل، أي تفترضان معدلًا
  ثابتًا. هواتف المراسلين تسجّل بمعدل متغير، والنسخة الخفيفة تحفظ طوابعه (`-copyts`). هنا يمر كل إطار إلى الكاشف
  برقمه، ويُترجم رقم إطار القطع إلى طابعه الحقيقي `frame.time`، فتقع الحدود على خط زمن الأصل كما يشترط العقد للمشتقات.
- **الإطار:** يُصغَّر إلى عرض `ANALYSIS_WIDTH` قبل الكشف. فرق اللون والحواف لا يحتاج 480p، والتصغير يقلل الزمن.
- **الناتج:** حدود وطوابع فقط، بلا وصف بصري ولا نص. ربط اللقطة بمقاطع التفريغ بأرقامها في `transcript.json`، فلا
  يحمل `shots.json` نص الكلام، ويبقى النص في المشتقين الحساسين وحدهما (R11).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .captions import Segment

ANALYSIS_WIDTH = 256
THRESHOLD = 27.0  # افتراض ContentDetector
MIN_SHOT_S = 0.5
FORMAT_VERSION = 1


@dataclass(frozen=True)
class Shot:
    start: float
    end: float


def detect_shots(path: Path, *, threshold: float = THRESHOLD, min_shot_s: float = MIN_SHOT_S,
                 origin_s: float | None = None) -> tuple[list[Shot], dict]:
    """حدود اللقطات بالثواني على خط زمن الأصل (الصفر = `origin_s`، بداية مسار الفيديو إن لم يُعطَ)."""
    import av
    from scenedetect.detectors import ContentDetector

    times: list[float] = []
    cuts: list[int] = []
    with av.open(str(path), metadata_errors="ignore") as c:
        video = next((s for s in c.streams if s.type == "video"), None)
        if video is None:
            return [], {"frames": 0}
        rate = float(video.average_rate or video.guessed_rate or 30)
        # min_scene_len بالإطارات عند الكاشف؛ يُحسب من متوسط المعدل، والحدود نفسها من الطوابع الحقيقية
        detector = ContentDetector(threshold=threshold, min_scene_len=max(1, round(min_shot_s * rate)))
        for frame in c.decode(video):
            if frame.time is None:
                continue
            h = max(2, round(frame.height * ANALYSIS_WIDTH / frame.width / 2) * 2)
            img = frame.reformat(width=ANALYSIS_WIDTH, height=h, format="bgr24").to_ndarray()
            cuts += detector.process_frame(len(times), img)
            times.append(float(frame.time))
        if not times:
            return [], {"frames": 0}
        end_s = times[-1] + 1.0 / rate
    zero = times[0] if origin_s is None else origin_s
    bounds = [times[0]] + [times[i] for i in sorted(set(cuts)) if 0 < i < len(times)] + [end_s]
    shots = [Shot(round(a - zero, 3), round(b - zero, 3)) for a, b in zip(bounds, bounds[1:]) if b > a]
    return shots, {"frames": len(times), "average_rate": round(rate, 3)}


def speech_segments(shot: Shot, segments: list[Segment]) -> list[int]:
    """أرقام مقاطع التفريغ (كما في transcript.json، بعد حذف الفارغة) التي يقع نصف مدتها على الأقل داخل اللقطة."""
    out = []
    kept = [s for s in segments if s.text.strip()]
    for i, s in enumerate(kept):
        overlap = min(s.end, shot.end) - max(s.start, shot.start)
        if s.end > s.start and overlap >= 0.5 * (s.end - s.start):
            out.append(i)
    return out


def to_json(shots: list[Shot], segments: list[Segment] | None, *, source: dict, stats: dict,
            threshold: float = THRESHOLD, min_shot_s: float = MIN_SHOT_S) -> str:
    doc = {
        "format_version": FORMAT_VERSION,
        "status": "draft",
        "route": "local",
        "source": source,
        "detector": {"name": "pyscenedetect-content", "threshold": threshold, "min_shot_s": min_shot_s,
                     "analysis_width": ANALYSIS_WIDTH, **stats},
        "shots": [
            {"index": i, "start": s.start, "end": s.end, "duration": round(s.end - s.start, 3),
             **({"speech_segments": speech_segments(s, segments)} if segments is not None else {})}
            for i, s in enumerate(shots)
        ],
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
