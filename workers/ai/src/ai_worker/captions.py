"""ملفا التفريغ من ناتج النموذج: JSON بالكلمات وطوابعها، وWebVTT عربي.

- **المسودة:** كلاهما مسودة (`status: draft`). لا يُنشر شيء ولا تُعدَّل المادة؛ المنتج يراجع ويعتمد (الخطة، «الضوابط
  التحريرية»).
- **بداية العبارة:** من الطابع الزمني لأول كلمة فيها، لا من بداية مقطع النموذج. مقطع Whisper يبدأ حيث انتهى سابقه
  فيسبق الكلام بطول الصمت؛ القياس في `docs/measurements/asr-bench/REPORT.md` (87.5% من البدايات ضمن 500 ms من
  طوابع الكلمات مقابل 62.5% من بدايات المقاطع).
- **الاتجاه:** WebVTT لا يحمل خاصية اتجاه؛ كل سطر يبدأ بعلامة RLM (U+200F)، فيعرضه المشغّل من اليمين حتى حين يبدأ
  السطر برقم أو كلمة لاتينية.
- **التقسيم:** حدود العبارة 42 حرفًا للسطر وسطران و7 ثوانٍ، أو صمت بين كلمتين أطول من `GAP_S`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

RLM = "‏"
MAX_LINE_CHARS = 42
MAX_LINES = 2
MAX_CUE_S = 7.0
GAP_S = 1.0
MIN_CUE_S = 0.5
FORMAT_VERSION = 1


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str
    probability: float | None = None


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str
    words: tuple[Word, ...]


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    lines: tuple[str, ...]


def _wrap(words: list[str]) -> list[str]:
    lines, cur = [], ""
    for w in words:
        cand = f"{cur} {w}" if cur else w
        if len(cand) > MAX_LINE_CHARS and cur:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def build_cues(segments: list[Segment]) -> list[Cue]:
    """عبارات الترجمة من الكلمات. مقطع بلا كلمات (محرك بلا طوابع كلمات) يصير عبارة بحدود المقطع."""
    cues: list[Cue] = []
    for seg in segments:
        words = [w for w in seg.words if w.text.strip()]
        if not words:
            if seg.text.strip():
                cues.append(Cue(seg.start, max(seg.end, seg.start + MIN_CUE_S), tuple(_wrap(seg.text.split()))))
            continue
        group: list[Word] = []
        for w in words:
            if group:
                text = [g.text.strip() for g in group] + [w.text.strip()]
                too_long = len(_wrap(text)) > MAX_LINES or w.end - group[0].start > MAX_CUE_S
                if too_long or w.start - group[-1].end > GAP_S:
                    cues.append(_cue(group))
                    group = []
            group.append(w)
        if group:
            cues.append(_cue(group))
    # لا تداخل: نهاية العبارة لا تتجاوز بداية التالية
    out = []
    for i, c in enumerate(cues):
        end = c.end if i + 1 == len(cues) else min(c.end, cues[i + 1].start)
        out.append(Cue(c.start, max(end, c.start + 0.001), c.lines))
    return out


def _cue(group: list[Word]) -> Cue:
    start, end = group[0].start, group[-1].end
    return Cue(start, max(end, start + MIN_CUE_S), tuple(_wrap([g.text.strip() for g in group])))


def _ts(seconds: float) -> str:
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def to_webvtt(cues: list[Cue]) -> str:
    # النص في رأس الملف بعد WEBVTT تعليق يتجاهله المشغّل؛ لا يحمل معرّفًا ولا اسمًا
    out = ["WEBVTT - draft, ar", ""]
    for i, c in enumerate(cues, 1):
        # "-->" في النص يكسر الملف؛ النموذج لا ينتجه عادة، لكنه يُستبدل احتياطًا
        lines = [RLM + line.replace("-->", "→") for line in c.lines]
        out += [str(i), f"{_ts(c.start)} --> {_ts(c.end)}", *lines, ""]
    return "\n".join(out)


def to_json(segments: list[Segment], *, duration_s: float, start_pts_us: int, engine: dict, source: dict) -> str:
    """المسودة بصيغة ثابتة الترتيب، فيعطي الإدخال نفسه البايتات نفسها (والبصمة نفسها) عند إعادة التسليم."""
    doc = {
        "format_version": FORMAT_VERSION,
        "status": "draft",
        "language": "ar",
        "route": "local",
        "duration_s": round(duration_s, 3),
        "start_pts_us": int(start_pts_us),
        "source": source,
        "engine": engine,
        "segments": [
            {
                "start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(),
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "text": w.text.strip(),
                     **({"probability": round(w.probability, 3)} if w.probability is not None else {})}
                    for w in s.words if w.text.strip()
                ],
            }
            for s in segments if s.text.strip()
        ],
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
