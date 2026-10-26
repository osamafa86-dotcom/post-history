"""قياس تقييم الجودة (الاهتزاز والصمت والتكرار) على مقطع اصطناعي بدقة النسخة الخفيفة، بحقيقة معروفة، ونتيجته بمخطط measurement.json.

    python bench/quality_bench.py make-clip <out.mp4> [shake_px]   # 854×480، 30 إطارًا/ث، دقيقتان، 24 لقطة
    docker run ... ai-worker:runtime ... python /bench/quality_bench.py run /clip/q.mp4 > result.json

اللقطات: ثابتة وتحريك ناعم واهتزاز بسعة `shake_px` (بكسل عند 854) وتكرار لقطات سابقة. الصوت نغمة وضجيج خفيف
مع خمسة مقاطع صمت معروفة وفجوة قصيرة (0.5 ث) لا يجب أن تُعد صمتًا.
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

SECONDS, FPS, SHOT_S, W, H, SR = 120.0, 30, 5.0, 854, 480, 16000
# لكل لقطة: (نسيج، حركة). النسيج المكرر يعني لقطة تكرر سابقة
PLAN = [(0, "still"), (1, "pan"), (2, "shake"), (3, "still"), (4, "pan"), (5, "shake"),
        (6, "still"), (0, "still"), (7, "pan"), (8, "shake"), (9, "still"), (3, "still"),
        (10, "pan"), (11, "shake"), (12, "still"), (13, "pan"), (6, "still"), (14, "shake"),
        (15, "still"), (16, "pan"), (17, "shake"), (9, "still"), (18, "pan"), (19, "still")]
SILENCES = [(7.0, 9.0), (31.0, 32.5), (55.0, 59.0), (80.0, 82.0), (101.0, 103.5)]
SHORT_GAP = (66.0, 66.5)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_clip(out: str, shake_px: str = "4") -> None:
    import av
    import numpy as np

    amp = int(shake_px)
    rng = np.random.default_rng(11)
    pad = 120
    grids = [rng.integers(0, 256, ((H + pad) // 24 + 1, (W + pad) // 24 + 1, 3)) for _ in range(20)]
    tex = [np.kron(g, np.ones((24, 24, 1)))[:H + pad, :W + pad].astype(np.uint8) for g in grids]
    with av.open(out, "w", format="mp4") as c:
        v = c.add_stream("mpeg4", rate=FPS)
        v.width, v.height, v.pix_fmt, v.bit_rate = W, H, "yuv420p", 2_500_000
        v.codec_context.time_base = Fraction(1, 600)
        a = c.add_stream("aac", rate=SR)
        a.layout = "mono"
        n = 0
        for t_i, move in PLAN:
            for k in range(int(SHOT_S * FPS)):
                ox = oy = pad // 2
                if move == "shake":
                    ox += int(rng.integers(-amp, amp + 1))
                    oy += int(rng.integers(-amp, amp + 1))
                elif move == "pan":
                    ox = 10 + k * 2 // 3  # 20 بكسل/ث
                f = av.VideoFrame.from_ndarray(np.ascontiguousarray(tex[t_i][oy:oy + H, ox:ox + W]), format="rgb24")
                f.pts, f.time_base = round(n * 600 / FPS), Fraction(1, 600)
                c.mux(v.encode(f))
                n += 1
        c.mux(v.encode(None))
        t = np.arange(int(SECONDS * SR)) / SR
        wave = (0.2 * np.sin(2 * np.pi * 220 * t) + 0.02 * rng.standard_normal(len(t))).astype(np.float32)
        for a0, a1 in SILENCES + [SHORT_GAP]:
            wave[(t >= a0) & (t < a1)] = 0.0005 * rng.standard_normal(int(((t >= a0) & (t < a1)).sum()))
        for i in range(0, len(wave), 1024):
            fr = av.AudioFrame.from_ndarray(wave[None, i:i + 1024], format="flt", layout="mono")
            fr.sample_rate, fr.pts = SR, i
            c.mux(a.encode(fr))
        c.mux(a.encode(None))


def cgroup_peak_mb() -> float | None:
    for p in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(Path(p).read_text()) / 1048576, 1)
        except (OSError, ValueError):
            continue
    return None


def run(clip: str) -> None:
    from ai_worker.quality import SHAKE_PX, assess, read_signals
    from ai_worker.shots import Shot

    started = now()
    t0 = time.perf_counter()
    sig = read_signals(Path(clip))
    shots = [Shot(i * SHOT_S, (i + 1) * SHOT_S) for i in range(len(PLAN))]  # الحدود معروفة: يُقاس التقييم وحده
    q, quiet = assess(shots, sig, origin_s=sig.times[0])
    took = time.perf_counter() - t0

    moves = [m for _, m in PLAN]
    truth_shaky = [m == "shake" for m in moves]
    got_shaky = [s["shaky"] for s in q]
    seen, truth_dup = {}, []
    for i, (t_i, _) in enumerate(PLAN):
        truth_dup.append(seen.get(t_i))
        seen.setdefault(t_i, i)
    got_dup = [s["duplicate_of"] for s in q]
    matched, errs = 0, []
    for a0, a1 in SILENCES:
        best = min(quiet, key=lambda r: abs(r[0] - a0) + abs(r[1] - a1), default=None)
        if best and abs(best[0] - a0) <= 0.5 and abs(best[1] - a1) <= 0.5:
            matched += 1
            errs += [abs(best[0] - a0) * 1000, abs(best[1] - a1) * 1000]

    def px(kind: str, f) -> float:
        return round(f(s["shake_px"] for s, m in zip(q, moves) if m == kind), 3)

    doc = {
        "schema_version": 1, "tool": "asr-bench", "role": "ai",
        "test_name": f"quality-2min-480p-shake{os.environ.get('BENCH_SHAKE', '4')}px-cpu",
        "started_at": started, "ended_at": now(), "result": "info",
        "device": {"platform": "server", "model": f"{os.environ.get('BENCH_CPU_MODEL', platform.processor())}, "
                                                  f"--cpus {os.environ.get('BENCH_CPUS', '?')}, CPU only",
                   "os_version": platform.platform()},
        "upload_path": "n/a",
        "file": {"duration_s": SECONDS, "codec": f"mpeg4 {W}x{H} {FPS} fps + aac 16 kHz mono (synthetic, like proxy-480p)"},
        "provider": "local: OpenCV phase correlation, dHash, PyAV audio level",
        "cost_usd": 0,
        "metrics": {
            "video_s": SECONDS, "frames": len(sig.times), "assess_s": round(took, 2),
            "rtf_cpu": round(took / SECONDS, 3), "peak_memory_mb": cgroup_peak_mb() or "not measured",
            "shake_amplitude_px_at_854": int(os.environ.get("BENCH_SHAKE", "4")), "shake_threshold_px_at_256": SHAKE_PX,
            "shaky_expected": sum(truth_shaky),
            "shaky_matched": sum(a and b for a, b in zip(truth_shaky, got_shaky)),
            "shaky_false_on_pan": sum(g for g, m in zip(got_shaky, moves) if m == "pan"),
            "shaky_false_on_still": sum(g for g, m in zip(got_shaky, moves) if m == "still"),
            "shake_px_still_max": px("still", max), "shake_px_pan_max": px("pan", max),
            "shake_px_shake_min": px("shake", min),
            "duplicates_expected": sum(d is not None for d in truth_dup),
            "duplicates_matched": sum(t is not None and t == g for t, g in zip(truth_dup, got_dup)),
            "duplicates_spurious": sum(t is None and g is not None for t, g in zip(truth_dup, got_dup)),
            "silences_expected": len(SILENCES), "silences_matched": matched,
            "silences_spurious": len(quiet) - matched,
            "silence_edge_error_ms_max": round(max(errs), 1) if errs else "none matched",
            "network": "none (docker --network none)",
        },
        "notes": ("Synthetic 2-minute clip, 24 known 5 s shots (11 still, 7 smooth pan at 20 px/s, 6 shaky), random "
                  "per-frame shake of the given amplitude, 4 shots repeating earlier ones, 5 known silences of 1.5-4 s "
                  "and one 0.5 s gap that must not count. Shot bounds are given, so this measures the assessment alone. "
                  "Real footage (walking, zoom, low light, wind noise) not measured."),
    }
    print(json.dumps(doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if sys.argv[1] == "make-clip":
        make_clip(sys.argv[2], *(sys.argv[3:4]))
    else:
        run(sys.argv[2])
