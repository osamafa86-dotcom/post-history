"""قائمة اللقطات المسودة (ADR 0024): توقيت كل لقطة ومدتها ومقتطف الكلام المتداخل معها.

تُبنى من ناتج كشف اللقطات ومقاطع التفريغ، فلا يُعاد فك الفيديو. بلا وصف بصري في الإصدار الأول،
ونوع اللقطة والترجمة الإنجليزية `null` إلى أن يُقاس كل منهما محليًا. حساسة كالتفريغ (R11).
"""

from __future__ import annotations

import json

from .captions import Segment
from .shots import Shot, speech_segments

FORMAT_VERSION = 1
EXCERPT_MAX = 280


def excerpt(shot: Shot, segments: list[Segment]) -> str | None:
    kept = [s for s in segments if s.text.strip()]
    text = " ".join(kept[i].text.strip() for i in speech_segments(shot, segments))
    if not text:
        return None
    if len(text) <= EXCERPT_MAX:
        return text
    cut = text[:EXCERPT_MAX - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > EXCERPT_MAX // 2 else cut).rstrip() + "…"


def to_json(shots: list[Shot], segments: list[Segment] | None, *, source: dict) -> str:
    """صيغة ثابتة الترتيب كالتفريغ، فيعطي الإدخال نفسه البصمة نفسها."""
    doc = {
        "format_version": FORMAT_VERSION,
        "status": "draft",
        "language": "ar",
        "route": "local",
        "source": source,
        "shots": [
            {"index": i, "start_us": round(s.start * 1e6), "end_us": round(s.end * 1e6),
             "duration_ms": max(1, round((s.end - s.start) * 1000)), "shot_type": None,
             "excerpt": excerpt(s, segments) if segments else None, "excerpt_en": None}
            for i, s in enumerate(shots)
        ],
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
