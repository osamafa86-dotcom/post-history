"""تقييم الجودة محليًا على النسخة الخفيفة: الاهتزاز والصمت وتكرار اللقطة (الخطة، «نطاق الإصدار الأول»).

- **الاهتزاز:** إزاحة كل إطار عن سابقه بالارتباط الطوري (OpenCV) على إطار رمادي بعرض `ANALYSIS_WIDTH`. الحركة
  المقصودة (تحريك الكاميرا) ناعمة، فيُطرح منها متوسطها المتحرك، ويبقى الاهتزاز: جذر متوسط مربع الباقي بالبكسل لكل لقطة.
- **الصمت:** مستوى الصوت لكل نافذة 50 ms بالـ dBFS. الصمت مدى تحت `SILENCE_DB` لا يقل عن `SILENCE_MIN_S`.
- **التكرار:** بصمة فرق (dHash، 256 بتًا) لإطار وسط كل لقطة. اللقطة مكررة إن قاربت بصمة لقطة قبلها بمسافة
  هامنغ لا تتجاوز `DUP_MAX_BITS`.

الناتج أرقام وحدود فقط، بلا صورة ولا نص، ومسودة يحكم فيها المنتج. العتبات افتراضية، وقيمها المقيسة في ملحق ADR 0065.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .shots import ANALYSIS_WIDTH, Shot

SMOOTH_S = 0.5
SHAKE_PX = 0.5
SILENCE_DB = -45.0
SILENCE_MIN_S = 1.0
WINDOW_S = 0.05
HASH_SIZE = 16  # بصمة 16×16 = 256 بتًا
DUP_MAX_BITS = 24


@dataclass(frozen=True)
class Signals:
    times: list[float]
    motion: list[tuple[float, float]]  # إزاحة كل إطار عن سابقه، والأول (0، 0)
    hashes: list[int]
    silences: list[tuple[float, float]]


def dhash(gray) -> int:
    import cv2

    small = cv2.resize(gray, (HASH_SIZE + 1, HASH_SIZE), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return int(sum(1 << i for i, b in enumerate(bits) if b))


def silences(levels_db: list[float], window_s: float = WINDOW_S, start_s: float = 0.0,
             threshold_db: float = SILENCE_DB, min_s: float = SILENCE_MIN_S) -> list[tuple[float, float]]:
    out, run_start = [], None
    for i, db in enumerate(levels_db + [0.0]):  # حارس ينهي آخر مدى
        if db < threshold_db and i < len(levels_db):
            run_start = i if run_start is None else run_start
        elif run_start is not None:
            if (i - run_start) * window_s >= min_s:
                out.append((round(start_s + run_start * window_s, 3), round(start_s + i * window_s, 3)))
            run_start = None
    return out


def read_signals(path: Path) -> Signals:
    import av
    import cv2
    import numpy as np

    times, motion, hashes, levels, audio_start = [], [], [], [], None
    with av.open(str(path), metadata_errors="ignore") as c:
        video = next((s for s in c.streams if s.type == "video"), None)
        if video is not None:
            prev, window = None, None
            for frame in c.decode(video):
                if frame.time is None:
                    continue
                h = max(2, round(frame.height * ANALYSIS_WIDTH / frame.width / 2) * 2)
                gray = frame.reformat(width=ANALYSIS_WIDTH, height=h, format="gray").to_ndarray().astype(np.float32)
                if window is None:
                    window = cv2.createHanningWindow(gray.shape[::-1], cv2.CV_32F)
                (dx, dy), _ = cv2.phaseCorrelate(prev, gray, window) if prev is not None else ((0.0, 0.0), 0)
                motion.append((float(dx), float(dy)))
                hashes.append(dhash(gray))
                times.append(float(frame.time))
                prev = gray
    with av.open(str(path), metadata_errors="ignore") as c:
        audio = next((s for s in c.streams if s.type == "audio"), None)
        if audio is not None:
            rs = av.AudioResampler(format="flt", layout="mono", rate=16000)
            per = round(16000 * WINDOW_S)
            buf = np.zeros(0, dtype=np.float32)
            for frame in c.decode(audio):
                if audio_start is None and frame.time is not None:
                    audio_start = float(frame.time)
                for out in rs.resample(frame):
                    buf = np.concatenate([buf, out.to_ndarray().reshape(-1)])
                while len(buf) >= per:
                    chunk, buf = buf[:per], buf[per:]
                    rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
                    levels.append(20 * np.log10(max(rms, 1e-9)))
    return Signals(times, motion, hashes, silences(levels, start_s=audio_start or 0.0))


def jitter_px(motion: list[tuple[float, float]], rate: float, smooth_s: float = SMOOTH_S) -> float:
    """جذر متوسط مربع الإزاحة بعد طرح متوسطها المتحرك: يبقى الاهتزاز ويُطرح التحريك المقصود."""
    import numpy as np

    if len(motion) < 3:
        return 0.0
    m = np.array(motion[1:], dtype=np.float64)
    k = max(3, int(round(smooth_s * rate)) | 1)
    kernel = np.ones(k) / k
    pad = k // 2
    smooth = np.stack([np.convolve(np.pad(m[:, j], pad, mode="edge"), kernel, mode="valid") for j in (0, 1)], axis=1)
    return float(np.sqrt(np.mean(np.sum((m - smooth) ** 2, axis=1))))


def assess(shots: list[Shot], sig: Signals, origin_s: float) -> tuple[list[dict], list[tuple[float, float]]]:
    """لكل لقطة: الاهتزاز بالبكسل وعلمه، ونسبة الصمت، وأول لقطة سابقة تكررها. والصمت على خط زمن الأصل."""
    rate = (len(sig.times) - 1) / (sig.times[-1] - sig.times[0]) if len(sig.times) > 1 else 30.0
    rel = [t - origin_s for t in sig.times]
    quiet = [(round(a - origin_s, 3), round(b - origin_s, 3)) for a, b in sig.silences]
    out, mids = [], []
    for s in shots:
        idx = [i for i, t in enumerate(rel) if s.start <= t < s.end]
        shake = round(jitter_px([sig.motion[i] for i in idx], rate), 3) if idx else 0.0
        mid = sig.hashes[idx[len(idx) // 2]] if idx else None
        dup = next((j for j, h in enumerate(mids) if h is not None and mid is not None
                    and bin(h ^ mid).count("1") <= DUP_MAX_BITS), None)
        mids.append(mid)
        silent = sum(max(0.0, min(b, s.end) - max(a, s.start)) for a, b in quiet)
        out.append({"shake_px": shake, "shaky": shake > SHAKE_PX,
                    "silent_ratio": round(silent / (s.end - s.start), 3) if s.end > s.start else 0.0,
                    "duplicate_of": dup})
    return out, quiet
