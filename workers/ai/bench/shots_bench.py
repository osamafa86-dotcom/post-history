"""قياس زمن كشف اللقطات وذاكرته على مقطع اصطناعي بدقة النسخة الخفيفة، في الحاوية المحصّنة، ونتيجته بمخطط measurement.json.

    python bench/shots_bench.py make-clip <out.mp4>          # 854×480، 30 إطارًا/ث، دقيقتان، قطع كل 5 ث، نسيج متحرك
    docker run ... ai-worker:runtime ... python /bench/shots_bench.py run /clip/shots.mp4 > result.json

الحدود معروفة، فيُحسب أيضًا عدد القطع المكتشف وأكبر خطأ في موضعه. الذاكرة ذروة cgroup للحاوية.
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

SECONDS, FPS, EVERY_S, W, H = 120.0, 30, 5.0, 854, 480


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_clip(out: str, contrast: str = "real") -> None:
    """contrast=real: لقطتان متجاورتان تختلفان سطوعًا بـ 60 على الأقل، كما في أغلب القطع الحقيقية.
    contrast=random: ألوان عشوائية بلا شرط، وفيها قطع بين لونين متقاربين يصعب على أي كاشف محتوى."""
    import av
    import numpy as np

    rng = np.random.default_rng(7)
    shots = int(SECONDS / EVERY_S)
    # لكل لقطة لون أساس وسطوع مختلفان، ونسيج يتحرك داخلها كي لا تكون اللقطة ثابتة
    bases = [rng.integers(20, 235, 3)]
    while len(bases) < shots:
        b = rng.integers(20, 235, 3)
        if contrast == "random" or abs(int(b.mean()) - int(bases[-1].mean())) >= 60:
            bases.append(b)
    texture = rng.integers(-40, 41, (H + 64, W + 64, 1))
    with av.open(out, "w", format="mp4") as c:
        v = c.add_stream("mpeg4", rate=FPS)
        v.width, v.height, v.pix_fmt, v.bit_rate = W, H, "yuv420p", 1_500_000
        for i in range(int(SECONDS * FPS)):
            shot = int(i / (EVERY_S * FPS))
            dx = (i * 2) % 64
            img = np.clip(bases[shot][None, None, :] + texture[dx:dx + H, dx:dx + W], 0, 255).astype(np.uint8)
            f = av.VideoFrame.from_ndarray(img, format="rgb24")
            f.pts = i
            c.mux(v.encode(f))
        c.mux(v.encode(None))


def cgroup_peak_mb() -> float | None:
    for p in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(Path(p).read_text()) / 1048576, 1)
        except (OSError, ValueError):
            continue
    return None


def run(clip: str) -> None:
    from ai_worker.shots import detect_shots

    started = now()
    t0 = time.perf_counter()
    shots, stats = detect_shots(Path(clip))
    took = time.perf_counter() - t0
    expected = [k * EVERY_S for k in range(1, int(SECONDS / EVERY_S))]
    found = [s.start for s in shots[1:]]
    # قطع متوقع يُعد مكتشفًا إن وُجد قطع ضمن نصف ثانية منه؛ الخطأ على المكتشف وحده
    near = [min((abs(f - e) for f in found), default=1e9) for e in expected]
    err = [d * 1000 for d in near if d <= 0.5]
    doc = {
        "schema_version": 1, "tool": "asr-bench", "role": "ai", "test_name": "shot-detect-2min-480p-cpu",
        "started_at": started, "ended_at": now(), "result": "info",
        "device": {"platform": "server", "model": f"{os.environ.get('BENCH_CPU_MODEL', platform.processor())}, "
                                                  f"--cpus {os.environ.get('BENCH_CPUS', '?')}, CPU only",
                   "os_version": platform.platform()},
        "upload_path": "n/a",
        "file": {"duration_s": SECONDS, "codec": f"mpeg4 {W}x{H} {FPS} fps (synthetic, like proxy-480p)"},
        "provider": "local: PySceneDetect ContentDetector on PyAV frames",
        "cost_usd": 0,
        "metrics": {
            "video_s": SECONDS, "frames": stats["frames"], "detect_s": round(took, 2),
            "rtf_cpu": round(took / SECONDS, 3), "peak_memory_mb": cgroup_peak_mb() or "not measured",
            "cuts_expected": len(expected), "cuts_matched": len(err), "cuts_missed": len(expected) - len(err),
            "cuts_spurious": max(0, len(found) - len(err)),
            "cut_error_ms_max": round(max(err), 1) if err else "none matched",
            "contrast": os.environ.get("BENCH_CONTRAST", "real"),
            "network": "none (docker --network none)",
        },
        "notes": ("Synthetic 2-minute clip, a cut every 5 s, moving texture inside each shot; contrast=real keeps "
                  "neighbouring shots 60+ apart in brightness, contrast=random does not. Boundary accuracy and speed "
                  "only; no visual description and no text. Real footage (fades, pans, flashes) not measured."),
    }
    print(json.dumps(doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if sys.argv[1] == "make-clip":
        make_clip(sys.argv[2], *(sys.argv[3:4]))
    else:
        run(sys.argv[2])
