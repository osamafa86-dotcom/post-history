"""معايرة `MATCH_DISTANCE` للبصمة الإدراكية (`media_worker.phash`) على مجموعة مقاطع اصطناعية متنوعة.

- **المكررات:** كل مصدر بعد تحويلات لا تغيّر المحتوى: إعادة ترميز بجودة منخفضة، وتصغير إلى 360p، وتغيير الإضاءة،
  ومربع صغير فوق الصورة (كشعار)، ومعدل إطارات مختلف.
- **غير المكررات:** كل زوج من مصادر مختلفة المحتوى.
- **خارج النطاق (يُقاس ويُعلن):** قص 10% من الإطار، وإزاحة زمنية 3 ث.

يُعلن أكبر مسافة بين المكررات وأصغرها بين غير المكررات، ومعدلا الخطأ عند الحد الحالي والموصى به. الحد الموصى به أعلى
قيمة تترك هامشًا 25% تحت أقرب زوج مختلف (لا قبول خاطئ بهامش)، لأن المجموعتين متداخلتان فلا حد يفصلهما كليًّا.

    PYTHONPATH=workers/media/src python tools/render-bench/phash_calibration.py \\
        --out docs/measurements/render-bench/<date>-phash-calibration.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.ffmpeg import FFMPEG, run
from media_worker.phash import MATCH_DISTANCE, distance, video_phash

SECONDS = 24
SIZE = "1280x720"
SOURCES = {
    "testsrc2": f"testsrc2=size={SIZE}:rate=30",
    "testsrc": f"testsrc=size={SIZE}:rate=30",
    "smptehdbars-pan": f"smptehdbars=size={SIZE}:rate=30,scroll=horizontal=0.002",
    "mandelbrot": f"mandelbrot=size={SIZE}:rate=30",
    "life": f"life=size={SIZE}:rate=30:mold=10:ratio=0.2:death_color=#202020:life_color=#e0e0e0",
    "cellauto": f"cellauto=size={SIZE}:rate=30:rule=110",
    "gradients": f"gradients=size={SIZE}:rate=30:speed=0.02:c0=red:c1=blue:c2=yellow",
    "zoneplate": f"zoneplate=size={SIZE}:rate=30:kt2=4",
    "sierpinski": f"sierpinski=size={SIZE}:rate=30:type=triangle",
    "noise-blobs": f"color=gray:size={SIZE}:rate=30,noise=alls=60:allf=t,boxblur=24:2",
}
DUPLICATE_VF = {
    "reencode-crf38": None,
    "scale-360p": "scale=-2:360",
    "brightness": "eq=brightness=0.08:contrast=1.1",
    "logo-box": "drawbox=x=iw-260:y=40:w=220:h=90:color=white@0.8:t=fill",
    "fps-25": "fps=25",
}
OUT_OF_SCOPE_VF = {"crop-10pct": "crop=iw*0.9:ih*0.9", "shift-3s": None}


def master(src_filter: str, out: Path) -> Path:
    """نسخة رئيسة واحدة لكل مصدر (بعض المصادر عشوائية في كل تشغيل)، تُشتق منها كل التحويلات."""
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", f"{src_filter},trim=duration={SECONDS + 3}", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
         "-pix_fmt", "yuv420p", str(out)], 300)
    return out


def encode(src: Path, out: Path, vf: str | None = None, crf: int = 23, skip: float = 0.0) -> Path:
    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(skip), "-t", str(SECONDS),
            "-i", str(src)]
    if vf:
        args += ["-vf", vf]
    run(args + ["-c:v", "libx264", "-preset", "ultrafast", "-crf", str(crf), "-pix_fmt", "yuv420p", str(out)], 300)
    return out


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    started = now()
    dup, oos, base = [], {k: [] for k in OUT_OF_SCOPE_VF}, {}
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        for name, flt in SOURCES.items():
            f = master(flt, d / f"{name}.master.mp4")
            base[name] = video_phash(encode(f, d / f"{name}.mp4"))
            for t, vf in DUPLICATE_VF.items():
                h = video_phash(encode(f, d / f"{name}-{t}.mp4", vf, crf=38 if t == "reencode-crf38" else 23))
                dup.append((name, t, distance(base[name], h)))
            oos["crop-10pct"].append(distance(base[name], video_phash(
                encode(f, d / f"{name}-crop.mp4", OUT_OF_SCOPE_VF["crop-10pct"]))))
            oos["shift-3s"].append(distance(base[name], video_phash(encode(f, d / f"{name}-shift.mp4", skip=3))))
            print(name, [round(x[2], 1) for x in dup if x[0] == name])
    diff = [(a, b, distance(base[a], base[b])) for a, b in itertools.combinations(SOURCES, 2)]
    max_dup = max(x[2] for x in dup)
    min_diff = min(x[2] for x in diff)
    recommended = float(int(0.75 * min_diff))
    metrics = {
        "sources": len(SOURCES), "duplicate_pairs": len(dup), "different_pairs": len(diff),
        "duplicate_distance_max": round(max_dup, 2), "different_distance_min": round(min_diff, 2),
        "different_distance_min_pair": "/".join(min(diff, key=lambda x: x[2])[:2]),
        "duplicate_worst": "/".join(max(dup, key=lambda x: x[2])[:2]),
        "recommended_match_distance": recommended, "current_match_distance": MATCH_DISTANCE,
        "false_reject_at_current": sum(x[2] > MATCH_DISTANCE for x in dup),
        "false_accept_at_current": sum(x[2] <= MATCH_DISTANCE for x in diff),
        "false_reject_at_recommended": sum(x[2] > recommended for x in dup),
        "false_accept_at_recommended": sum(x[2] <= recommended for x in diff),
        "false_reject_at_recommended_logo_box": sum(x[2] > recommended for x in dup if x[1] == "logo-box"),
        "crop_10pct_distance_min": round(min(oos["crop-10pct"]), 2),
        "shift_3s_distance_min": round(min(oos["shift-3s"]), 2),
        "ffmpeg_version": ffmpeg.version(),
    }
    record = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "phash-calibration",
        "started_at": started, "ended_at": now(),
        # مقاطع اصطناعية لا مجموعة مواد حقيقية؛ المعايرة النهائية على عينة المراسلين محليًا
        "result": "partial",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(SECONDS), "codec": "h264", "vfr": False, "hdr": False},
        "metrics": metrics,
    }
    if args.out:
        args.out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
