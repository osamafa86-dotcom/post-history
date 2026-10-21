"""اختبار القبول «مطابقة الطوابع الزمنية» على مقاطع اصطناعية: محاذاة صوتية بين نسخة الهاتف الخفيفة والأصل بإزاحة لا
تتجاوز 40 ms على عشرة ملفات بمعدل إطارات متغير وفجوات زمنية (`media_worker.align.measure_offset`).

لكل ملف: أصل 60 ث بمعدل متغير وفجوة في الصورة وبداية غير صفرية، وصوت كالكلام (ضجيج تقطعه بوابة غير دورية)؛ ونسخة
هاتف 240p تبدأ بعده بمقدار عشوائي ثابت البذرة وطوابعها مصفَّرة كما يفعل مشفر العتاد. المرجع: بداية ملف الأصل +
مقدار البدء. المعيار: |الإزاحة المقيسة − المرجع| ≤ 40 ms في الملفات كلها.

    PYTHONPATH=workers/media/src python tools/render-bench/timestamp_alignment.py \\
        --out docs/measurements/render-bench/<date>-timestamp-alignment.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.align import THRESHOLD_MS, measure_offset
from media_worker.ffmpeg import FFMPEG, FFPROBE, run

GATE = "gt(sin(2*PI*{a}*t)*sin(2*PI*{b}*t+1)*sin(2*PI*{c}*t+2)\\,0.08)"


def make_pair(d: Path, i: int, rng: random.Random, seconds: int) -> tuple[Path, Path, float]:
    start = round(rng.uniform(0, 6), 3)
    skip = round(rng.uniform(0, 2.5), 3)
    gap = round(rng.uniform(10, seconds - 15), 2)
    gate = GATE.format(a=round(rng.uniform(0.5, 0.9), 3), b=round(rng.uniform(1.1, 1.6), 3),
                       c=round(rng.uniform(0.2, 0.4), 3))
    src, prx = d / f"o{i}.mov", d / f"p{i}.mp4"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={seconds}",
         "-f", "lavfi", "-i", f"aevalsrc='(random(0)-0.5)*{gate}':s=48000:d={seconds}",
         "-vf", f"select='not(eq(mod(n\\,7)\\,3))*not(between(t\\,{gap}\\,{gap + 2}))'", "-fps_mode", "vfr",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-output_ts_offset", str(start), str(src)],
        timeout_s=300)
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(skip), "-i", str(src),
         "-vf", "scale=-2:240", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "64k", str(prx)],
        timeout_s=300)
    file_start = float(run([FFPROBE, "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0",
                            str(src)], timeout_s=30))
    return src, prx, (file_start + skip) * 1000


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--files", type=int, default=10)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--seed", type=int, default=20261021)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    started, errors, conf, times, reliable = now(), [], [], [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(args.files):
            src, prx, truth = make_pair(Path(tmp), i, rng, args.seconds)
            t = time.perf_counter()
            r = measure_offset(prx, src)
            times.append(time.perf_counter() - t)
            errors.append(abs(r["offset_ms"] - truth))
            conf.append(r["confidence"])
            reliable += r["reliable"]
            print(i, round(truth, 1), r)
            src.unlink()
            prx.unlink()
    ok = max(errors) <= THRESHOLD_MS and reliable == args.files
    record = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "timestamp-alignment",
        "started_at": started, "ended_at": now(),
        # الشق الآلي على مقاطع اصطناعية؛ ملفات الهواتف الحقيقية يقيسها السكربت الميداني بالأداة نفسها
        "result": "partial" if ok else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(args.seconds), "codec": "h264", "vfr": True, "hdr": False},
        "metrics": {"files": args.files, "offset_error_ms_max": round(max(errors), 1),
                    "offset_error_ms_mean": round(sum(errors) / len(errors), 1),
                    "confidence_min": round(min(conf), 3), "reliable_files": reliable, "measure_s_max": round(max(times), 2),
                    "threshold_ms": THRESHOLD_MS, "seed": args.seed, "ffmpeg_version": ffmpeg.version()},
    }
    if args.out:
        args.out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
