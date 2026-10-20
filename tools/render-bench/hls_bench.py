"""زمن إنتاج HLS من مقطع دقيقتين 1080p وانحراف مدته (التذكرة 5 للوسائط).

المصدر مقطع av_sync نفسه (120s-1080p30). الخط: make_proxy ثم make_hls (إعادة تغليف بلا ترميز). الانحراف = مجموع
مدد مقاطع القائمة مقابل مدة فيديو المصدر الاسمية (عدد الإطارات ÷ المعدل). المعيار 40 ms.

    PYTHONPATH=workers/media/src python tools/render-bench/hls_bench.py \\
        --out docs/measurements/render-bench/<date>-hls-2min-1080p.json
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from pathlib import Path

import av_sync
from media_worker import ffmpeg
from media_worker.hls import make_hls, playlist_duration_s
from media_worker.probe import probe
from media_worker.proxy import make_proxy


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    case = next(c for c in av_sync.CASES if c.name == "120s-1080p30")
    started = av_sync.now()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "src.mp4"
        av_sync.make_source(case, src)
        source = probe(src)
        t = time.perf_counter()
        proxy = make_proxy(src, Path(tmp) / "proxy.mp4", source)
        proxy_s = time.perf_counter() - t
        t = time.perf_counter()
        files = make_hls(Path(tmp) / "proxy.mp4", Path(tmp) / "hls", proxy.duration_ms)
        hls_s = time.perf_counter() - t
        hls_dur = playlist_duration_s(files[0])
        segments = [f for f in files if f.suffix == ".m4s"]
        seg_durs = [float(x.split(":", 1)[1].split(",")[0])
                    for x in files[0].read_text().splitlines() if x.startswith("#EXTINF:")]
        size = sum(f.stat().st_size for f in files)
    nominal = source.frame_count / case.rate
    drift_ms = abs(hls_dur - nominal) * 1000
    result = {
        "schema_version": 1, "tool": "render-bench", "role": "media", "test_name": "hls-2min-1080p",
        "started_at": started, "ended_at": av_sync.now(),
        # يثبت اتساق مدة القائمة لا تزامن الصوت والصورة داخل المقاطع (ذاك في av_sync)
        "result": "pass" if drift_ms <= av_sync.THRESHOLD_MS else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"},
        "upload_path": "n/a",
        "metrics": {
            "proxy_s": round(proxy_s, 3), "hls_package_s": round(hls_s, 3), "total_s": round(proxy_s + hls_s, 3),
            "segments": len(segments), "segment_s_max": max(seg_durs), "segment_s_min": min(seg_durs),
            "hls_duration_s": round(hls_dur, 3), "source_video_duration_s": round(nominal, 3),
            "playlist_duration_drift_ms": round(drift_ms, 3), "hls_bytes": size,
            "threshold_ms": av_sync.THRESHOLD_MS, "ffmpeg_version": ffmpeg.version(),
        },
        "notes": ("مصدر اصطناعي 120 ث 1080p30 (مقطع av_sync). HLS fMP4 بمقاطع ~4 ث من النسخة الخفيفة بإعادة تغليف "
                  "(-c copy، -copyts) بلا ترميز ثانٍ، فزمن HLS هو التغليف وحده وزمن النسخة الخفيفة مذكور منفصلًا. "
                  "حاوية سحابية، لا خادم الوسائط المعتمد."),
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
