"""بصمة إدراكية للفيديو: pHash (DCT 32×32، أعلى 8×8 دون المركّبة الثابتة) لإطار كل ثانيتين، حتى 32 إطارًا.

تطابق مقطعين = متوسط مسافة هامنغ بين الإطارات المتقابلة زمنيًا ≤ `MATCH_DISTANCE`. تصمد لإعادة الترميز وتغيير
الدقة ومعدل البت، ولا تصمد للقص أو الإزاحة الزمنية (خارج نطاق هذه المرحلة). ترشّح المكررات فقط ولا تمنح حقًا.
"""

from __future__ import annotations

import math
import statistics
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run

INTERVAL_S = 2
MAX_FRAMES = 32
SIZE = 32
# معايرة على 10 مصادر اصطناعية (docs/measurements/render-bench/2026-10-21-phash-calibration.json): أقرب زوج مختلف 27.2،
# فـ 20 يترك هامشًا 25% بلا قبول خاطئ، ويقبل إعادة الترميز والتصغير والإضاءة ومعدل الإطارات في المحتوى المنقوش.
# لا يصمد لشعار مضاف ولا للمحتوى الأملس أو الضجيجي، ولا للقص والإزاحة؛ يرشّح فقط ولا يمنع.
MATCH_DISTANCE = 20.0
_COS = [[math.cos((2 * x + 1) * u * math.pi / (2 * SIZE)) for x in range(SIZE)] for u in range(8)]


def _frame_hash(px: bytes) -> int:
    rows = [px[r * SIZE:(r + 1) * SIZE] for r in range(SIZE)]
    # DCT منفصلة، والمعاملات الثمانية الأولى في كل اتجاه فقط
    tmp = [[sum(c[x] * row[x] for x in range(SIZE)) for c in _COS] for row in rows]
    coeffs = [sum(_COS[v][y] * tmp[y][u] for y in range(SIZE)) for v in range(8) for u in range(8)]
    ac = coeffs[1:]
    med = statistics.median(ac)
    bits = 0
    for c in ac:
        bits = (bits << 1) | (c > med)
    return bits


def video_phash(src: Path, timeout_s: float = 120) -> list[str]:
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", *INPUT_GUARD, "-i", str(src),
               "-map", "0:v:0", "-vf", f"fps=1/{INTERVAL_S},scale={SIZE}:{SIZE}:flags=area,format=gray",
               "-frames:v", str(MAX_FRAMES), "-f", "rawvideo", "-"], timeout_s, cwd=src.parent)
    n = SIZE * SIZE
    return [f"{_frame_hash(raw[i:i + n]):016x}" for i in range(0, len(raw) - n + 1, n)]


def distance(a: list[str], b: list[str]) -> float:
    pairs = list(zip(a, b))
    if not pairs:
        return 64.0
    return sum(bin(int(x, 16) ^ int(y, 16)).count("1") for x, y in pairs) / len(pairs)


def matches(a: list[str], b: list[str]) -> bool:
    return distance(a, b) <= MATCH_DISTANCE
