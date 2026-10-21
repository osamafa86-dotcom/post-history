"""مطابقة الطوابع الزمنية بين نسخة الهاتف الخفيفة والأصل بالارتباط المتبادل للصوت (الخطة: «المحاذاة الزمنية»).

مشفرات العتاد في الهواتف قد تصفّر بداية الطوابع في النسخة الخفيفة، فتُقاس الإزاحة من المحتوى نفسه: غلاف الطاقة
اللوغاريتمي لكل 10 ms من صوت أحادي 8 kHz، على خط زمن كل ملف المطلق (بداية مسار الصوت محسوبة)، ثم أعلى ارتباط بيرسون
على كل إزاحة بخطوة 10 ms في مدى ±`max_lag_s` (مجاميع تراكمية للمتوسط والتباين، فكل إزاحة جداء نقطي واحد)، وتنعيم
مكافئ للقمة. الثقة: قمة الارتباط، ومعها الفرق عن ثاني قمة بعيدة (تكرار نمط في الصوت يجعل القمة ملتبسة).

النتيجة `offset_ms`: ما يُضاف إلى زمن في النسخة الخفيفة ليقع على الزمن نفسه في الأصل. فإن تجاوز 40 ms تُصحَّح
نقاط القص المعبّر عنها على النسخة الخفيفة بإضافته. مكتبة قياسية فقط؛ القراءة بـ `INPUT_GUARD`.
"""

from __future__ import annotations

import json
import math
import operator
from array import array
from pathlib import Path

from .ffmpeg import FFMPEG, FFPROBE, INPUT_GUARD, run

RATE = 8000
HOP_S = 0.01
THRESHOLD_MS = 40.0
# تحت هذا الارتباط لا يُوثق بالإزاحة (صمت، أو صوتان مختلفان): لا تصحيح آلي، ويُترك القرار للمحرر
MIN_CONFIDENCE = 0.5
MIN_MARGIN = 0.05


def _audio_start_s(path: Path) -> float:
    out = run([FFPROBE, "-v", "error", *INPUT_GUARD, "-select_streams", "a:0", "-show_entries",
               "stream=start_time", "-of", "json", str(path)], timeout_s=60)
    streams = json.loads(out).get("streams") or []
    if not streams:
        raise ValueError("no audio stream")
    return float(streams[0].get("start_time") or 0.0)


def onset_envelope(path: Path, timeout_s: float = 600) -> tuple[float, list[float]]:
    """(بداية مسار الصوت بالثواني، غلاف البدايات لكل 10 ms). العينة الأولى المفكوكة تقع عند `start_time` للمسار."""
    pcm = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", *INPUT_GUARD, "-i", str(path),
               "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"], timeout_s=timeout_s)
    x = array("h")
    x.frombytes(pcm[: len(pcm) // 2 * 2])
    hop = int(RATE * HOP_S)
    energy = [math.log(1.0 + sum(v * v for v in x[i:i + hop]) / hop) for i in range(0, len(x) - hop + 1, hop)]
    return _audio_start_s(path), energy


def _prefix(xs: list[float]) -> tuple[list[float], list[float]]:
    s, q = [0.0], [0.0]
    for v in xs:
        s.append(s[-1] + v)
        q.append(q[-1] + v * v)
    return s, q


def _scores(a: list[float], b: list[float], lags: range, min_overlap: int) -> dict[int, float]:
    """ارتباط بيرسون بين a[i] وb[i + k] على التداخل لكل k."""
    sa, qa = _prefix(a)
    sb, qb = _prefix(b)
    out = {}
    for k in lags:
        lo, hi = max(0, -k), min(len(a), len(b) - k)
        n = hi - lo
        if n < min_overlap:
            continue
        ma, mb = (sa[hi] - sa[lo]) / n, (sb[hi + k] - sb[lo + k]) / n
        va = (qa[hi] - qa[lo]) - n * ma * ma
        vb = (qb[hi + k] - qb[lo + k]) - n * mb * mb
        if va <= 1e-9 or vb <= 1e-9:
            continue
        cov = sum(map(operator.mul, a[lo:hi], b[lo + k:hi + k])) - n * ma * mb
        out[k] = cov / math.sqrt(va * vb)
    return out


def measure_offset(proxy: Path, original: Path, max_lag_s: float = 10.0) -> dict:
    sp, ep = onset_envelope(proxy)
    so, eo = onset_envelope(original)
    # إطار j في الأصل مقابل إطار i في النسخة: الزمن المطلق so + j*h = sp + i*h + offset، فـ k = j − i
    span = int(max_lag_s / HOP_S)
    base = round((sp - so) / HOP_S)  # البحث حول فرق البدايتين
    scores = _scores(ep, eo, range(base - span, base + span + 1), min_overlap=max(200, min(len(ep), len(eo)) // 2))
    if not scores:
        return {"offset_ms": 0.0, "confidence": 0.0, "margin": 0.0, "reliable": False, "needs_correction": False}
    k = max(scores, key=scores.get)
    # ثاني قمة على بعد أكثر من 200 ms: إن قاربت الأولى فالمحاذاة ملتبسة
    second = max((v for j, v in scores.items() if abs(j - k) > 20), default=-1.0)
    l, c, r = scores.get(k - 1, scores[k]), scores[k], scores.get(k + 1, scores[k])
    frac = 0.5 * (l - r) / (l - 2 * c + r) if (l - 2 * c + r) < 0 else 0.0
    offset_s = so - sp + (k + frac) * HOP_S
    margin = c - second
    reliable = c >= MIN_CONFIDENCE and margin >= MIN_MARGIN
    return {"offset_ms": round(offset_s * 1000, 1), "confidence": round(c, 3), "margin": round(margin, 3),
            "reliable": reliable,
            "needs_correction": reliable and abs(offset_s * 1000) > THRESHOLD_MS}
