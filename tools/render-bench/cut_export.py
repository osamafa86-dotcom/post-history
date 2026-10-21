"""اختبار القبول «القص والتصدير»: مقاطع من الأصل بنقاط قص على خط زمن المصدر عبر `media_worker.render`.

لكل حالة: مصدر اصطناعي بعلامات ومضة/نغمة كل ثانيتين (`av_sync.make_source`)، وثلاثة مقاطع بنقاط قص عشوائية ثابتة
البذرة لا تقع على إطار مفتاحي. المرجع: موضع كل علامة في الناتج = مجموع أطوال المقاطع السابقة + (زمنها في المصدر −
بداية مقطعها). المقاييس:

- خطأ نقطة القص: أبعد علامة صورة في الناتج عن موضعها المرجعي (المعيار إطار واحد).
- التزامن: إزاحة كل نبضة عن ومضتها في الناتج (المعيار 40 ms).
- المدة: الناتج مقابل مجموع المقاطع (المعيار إطار لكل مقطع).
- HDR يخرج SDR بثمانية بتات، والعمودي يخرج بأبعاد العرض بلا دوران.

    PYTHONPATH=workers/media/src:tools/render-bench python tools/render-bench/cut_export.py \\
        --out docs/measurements/render-bench/<date>-cut-export.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import tempfile
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import av_sync
from av_sync import MARK_PERIOD_S, THRESHOLD_MS, Case, detect_marks, make_source
from media_worker import ffmpeg
from media_worker.ffmpeg import FFMPEG, run
from media_worker.probe import probe
from media_worker.render import Segment, render

CASES = (
    Case("30s-1080p30-vfr-offset", 30, vfr=True, start_offset=3.5),
    Case("30s-1080p25", 30, rate=25),
    Case("20s-1080p30-hlg", 20, start_offset=1.5, hdr_transfer="arib-std-b67"),
    replace(Case("20s-1080p30-portrait", 20), name="20s-1080p30-portrait"),
)
ROTATE = {"20s-1080p30-portrait": 90}


def segments_for(case: Case, start_s: float, rng: random.Random) -> list[Segment]:
    """ثلاثة مقاطع متتالية غير متداخلة، كل منها 4–7 ث، تبدأ في أجزاء عشوائية من الثانية."""
    out, t = [], start_s + 0.3
    for _ in range(3):
        a = t + rng.uniform(0.2, 1.7)
        b = a + rng.uniform(4.0, 7.0)
        if b > start_s + case.seconds - 0.2:
            break
        out.append(Segment(round(a * 1e6), round(b * 1e6)))
        t = b
    return out


def expected_marks(src_marks: list[float], segs: list[Segment]) -> list[float]:
    out, acc = [], 0.0
    for s in segs:
        a, b = s.start_us / 1e6, s.end_us / 1e6
        span = b - a
        # نبضة في أول 0.35 ث من المقطع لا يسبقها صمت كافٍ لـ silencedetect، فلا تُعد علامة مرجعية
        out += [acc + (m - a) for m in src_marks if a + 0.35 <= m < b - 0.1]
        acc += span
    return out


def measure(case: Case, workdir: Path, seed: int) -> dict:
    src = workdir / f"{case.name}.mp4"
    make_source(case, src)
    if case.name in ROTATE:
        turned = workdir / f"{case.name}.rot.mp4"
        run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-display_rotation",
             str(ROTATE[case.name]), "-i", str(src), "-c", "copy", str(turned)], 60)
        src = turned
    info = probe(src)
    segs = segments_for(case, info.start_pts_us / 1e6, random.Random(seed))
    out_path = workdir / f"{case.name}.out.mp4"
    out = render(src, out_path, info, segs)
    sv, _ = detect_marks(src, 600)
    ov, oa = detect_marks(out_path, 600)
    want = expected_marks(sv, segs)
    frame_ms = 1000 / case.rate
    cut_err = [min((abs(o - w) for o in ov), default=float("inf")) * 1000 for w in want]
    pairs = av_sync._pairs(ov, oa)
    av = [abs(a - v) * 1000 for v, a in pairs]
    total = sum(s.end_us - s.start_us for s in segs) / 1000
    dur_err = abs(out.duration_ms - total)
    portrait_ok = case.name not in ROTATE or (out.height > out.width and out.rotation == 0)
    r = {
        "segments": len(segs), "marks_expected": len(want), "marks_found": len(ov),
        "cut_error_ms_max": round(max(cut_err, default=float("nan")), 3),
        "av_offset_ms_max": round(max(av, default=float("nan")), 3),
        "duration_error_ms": round(dur_err, 1),
        "sdr_8bit": (not out.hdr) and out.bit_depth == 8, "orientation_ok": portrait_ok,
    }
    r["pass"] = (len(want) >= 4 and len(pairs) >= len(want) and r["cut_error_ms_max"] <= frame_ms + 1
                 and r["av_offset_ms_max"] <= THRESHOLD_MS and dur_err <= frame_ms * len(segs) + 1
                 and r["sdr_8bit"] and portrait_ok)
    return r


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--seed", type=int, default=20261021)
    args = ap.parse_args()
    started, metrics, ok = now(), {}, True
    with tempfile.TemporaryDirectory() as tmp:
        for case in CASES:
            r = measure(case, Path(tmp), args.seed)
            print(case.name, json.dumps(r))
            ok &= r.pop("pass")
            metrics.update({f"{case.name}_{k}": v for k, v in r.items()})
    record = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "cut-export",
        "started_at": started, "ended_at": now(),
        # مقاطع اصطناعية تحاكي الهواتف لا «صيغ الاختبار» المرجعية من ملفات حقيقية، فالنتيجة جزئية حتى تُقاس عليها
        "result": "partial" if ok else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": 30.0, "codec": "h264+hevc", "vfr": True, "hdr": True},
        "metrics": {**metrics, "seed": args.seed, "threshold_av_ms": THRESHOLD_MS, "mark_period_s": MARK_PERIOD_S,
                    "ffmpeg_version": ffmpeg.version()},
    }
    if args.out:
        args.out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
