"""اختيار مشغّل خريطة الألوان HDR→SDR: hable وmobius وreinhard (بإعداداتها) على مقاطع HLG وPQ اصطناعية، مقابل
المحتوى نفسه في مسار SDR.

- مقطع بمستوى SDR: محتوى SDR محوَّل فعلًا إلى HLG/PQ (أبيض 100 شمعة). يُقاس متوسط الإضاءة والمئين 95 على إطار كل
  ثانية بعد الخريطة (`video_filter` العامل نفسه بالمشغّل المجرَّب) ويُقارن بالمرجع؛ الشرط فرق ≤ 10% في الاثنين.
- مقطع مضيء: المحتوى نفسه أسطع بدرجتين (أبيض 400 شمعة) ليُرى ما يفعله المشغّل بالإضاءات العالية: نسبة البكسل
  المقصوص (≥ 234) وعدد المستويات المميزة فوق 180.
- المختار هو `TONEMAP` في `proxy.py`؛ يفشل القياس إن لم يحقق الشرط. لا ملف حقيقي ولا اتصال خارجي.

    python bench/tonemap_bench.py --out /results/<date>-tonemap-choice.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.ffmpeg import FFMPEG, run
from media_worker.probe import probe
from media_worker.proxy import PROXY_SHORT_SIDE, TONEMAP, video_filter

TRANSFERS = {"hlg": "arib-std-b67", "pq": "smpte2084"}
OPERATORS = ("hable:desat=0", "mobius:desat=0", "reinhard:desat=0", "mobius:param=0.7:desat=0",
             "mobius:param=0.8:desat=0", "mobius:param=0.9:desat=0", "reinhard:param=0.8:desat=0",
             "reinhard:param=0.9:desat=0")
MAX_DELTA = 0.10
CLIP_LEVEL = 234
SECONDS = 10


def make_clip(path: Path, transfer: str | None, exposure: float = 0.0) -> None:
    vf = "noise=alls=8:allf=t,format=yuv420p"
    if transfer:
        vf = ("noise=alls=8:allf=t,zscale=tin=bt709:min=bt709:pin=bt709:t=linear:p=bt709:npl=100,format=gbrpf32le,"
              f"exposure=exposure={exposure},"
              f"zscale=tin=linear:pin=bt709:min=gbr:p=bt2020:t={transfer}:m=bt2020nc:r=tv:npl=100,format=yuv420p10le")
    tags = ["-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc"] if transfer else []
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", f"testsrc2=size=1920x1080:rate=30:duration={SECONDS}", "-vf", vf, "-c:v", "libx265",
         "-preset", "ultrafast", "-b:v", "12M", "-x265-params", "log-level=error:pools=none", *tags, str(path)],
        timeout_s=600)


def luma(path: Path, vf: str) -> Counter:
    """مدرّج الإضاءة (8 بت) لإطار كل ثانية بعد المرشح."""
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
               "-vf", f"fps=1,{vf},format=gray", "-f", "rawvideo", "-"], timeout_s=600)
    return Counter(raw)


def mean_p95(h: Counter) -> tuple[float, int]:
    n = sum(h.values())
    acc = 0
    for v in range(256):
        acc += h.get(v, 0)
        if acc >= 0.95 * n:
            return sum(k * c for k, c in h.items()) / n, v
    return sum(k * c for k, c in h.items()) / n, 255


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    started, metrics, passing = now(), {}, []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        make_clip(d / "sdr.mkv", None)
        sdr = probe(d / "sdr.mkv")
        ref_mean, ref_p95 = mean_p95(luma(d / "sdr.mkv", video_filter(sdr, PROXY_SHORT_SIDE)))
        metrics.update({"sdr_reference_mean": round(ref_mean, 1), "sdr_reference_p95": ref_p95})
        clips = {}
        for name, transfer in TRANSFERS.items():
            make_clip(d / f"{name}.mkv", transfer)
            make_clip(d / f"{name}-bright.mkv", transfer, exposure=2.0)
            clips[name] = (probe(d / f"{name}.mkv"), probe(d / f"{name}-bright.mkv"))
        for op in OPERATORS:
            key = op.replace(":desat=0", "").replace(":param=", "_").replace(".", "")
            ok = True
            for name, (info, bright) in clips.items():
                m, p = mean_p95(luma(d / f"{name}.mkv", video_filter(info, PROXY_SHORT_SIDE, tonemap=op)))
                dm, dp = (m - ref_mean) / ref_mean, (p - ref_p95) / ref_p95
                ok &= abs(dm) <= MAX_DELTA and abs(dp) <= MAX_DELTA
                hb = luma(d / f"{name}-bright.mkv", video_filter(bright, PROXY_SHORT_SIDE, tonemap=op))
                n = sum(hb.values())
                metrics.update({
                    f"{key}_{name}_mean_delta_pct": round(100 * dm, 1), f"{key}_{name}_p95_delta_pct": round(100 * dp, 1),
                    f"{key}_{name}_bright_clipped_pct": round(100 * sum(c for v, c in hb.items() if v >= CLIP_LEVEL) / n, 2),
                    f"{key}_{name}_bright_levels_above_180": sum(1 for v in hb if v >= 180),
                })
            metrics[f"{key}_within_limit"] = ok
            if ok:
                passing.append(op)
            print(op, ok, {k: v for k, v in metrics.items() if k.startswith(key + "_")})
    chosen_ok = TONEMAP in passing
    result = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-tonemap-choice",
        "started_at": started, "ended_at": now(),
        "result": "pass" if chosen_ok else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(SECONDS), "codec": "hevc", "vfr": False, "hdr": True},
        "metrics": {**metrics, "chosen": TONEMAP, "operators_within_limit": ", ".join(passing) or "none",
                    "max_delta_pct": int(100 * MAX_DELTA), "ffmpeg_version": ffmpeg.version()},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    return 0 if chosen_ok else 1


if __name__ == "__main__":
    sys.exit(main())
