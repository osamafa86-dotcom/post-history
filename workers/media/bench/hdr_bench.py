"""قياس HDR: مقطع اصطناعي HEVC 10 بت بنقل HLG وآخر بنقل PQ يمران بالنسخة الخفيفة (`make_proxy`) والنسخة المنتَجة
(`render`)، ويُحكم على الناتج بأنه SDR BT.709 بوسوم صحيحة وبلا انهيار ألوان.

«انهيار الألوان» يُقاس بإحصاءات `signalstats` على كل إطارات الناتج (متوسط الإضاءة، ومداها بين المئين 10 و90،
ومتوسط التشبّع) مقارنةً بالمحتوى نفسه مرمّزًا SDR ومارًا بالمسار نفسه: يُقبل الناتج إن بقي متوسط الإضاءة بين
40 و200 (لا باهت محروق ولا معتم)، ومداها والتشبّع نصف المرجع على الأقل (لا تسطّح ولا رمادية). المصدر HDR محوَّل فعلًا من محتوى SDR (أبيض 100
شمعة)، وضابط سلبي يحوّله إلى 8 بت بلا خريطة ألوان يجب أن يكشفه المقياس، وإلا عُدّ القياس فاشلًا. لا ملف حقيقي ولا
اتصال خارجي. المخرج بمخطط contracts/schemas/measurement.json.

    python bench/hdr_bench.py --out /results/<date>-hdr-proxy-produced.json [--seconds 20]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from preview_slo import PROFILES  # noqa: E402

from media_worker import ffmpeg  # noqa: E402
from media_worker.ffmpeg import FFMPEG, run  # noqa: E402
from media_worker.probe import probe  # noqa: E402
from media_worker.proxy import make_proxy  # noqa: E402
from media_worker.render import Segment, render  # noqa: E402

X265 = ["-c:v", "libx265", "-preset", "ultrafast", "-b:v", "12M", "-tag:v", "hvc1"]


def hdr_profile(transfer: str, x265_transfer: str) -> tuple[str, list[str]]:
    """محتوى SDR محوَّل فعلًا إلى HDR (أبيض 100 شمعة)، لا قيم SDR موسومة HDR: فالمسار الذي يتجاهل الخريطة يفشل."""
    vf = ("noise=alls=8:allf=t,zscale=tin=bt709:min=bt709:pin=bt709:t=linear:p=bt709:npl=100,format=gbrpf32le,"
          f"zscale=tin=linear:pin=bt709:min=gbr:p=bt2020:t={transfer}:m=bt2020nc:r=tv:npl=100,format=yuv420p10le")
    return "1920x1080", ["-vf", vf, *X265, "-x265-params",
                         f"log-level=error:pools=none:colorprim=bt2020:transfer={x265_transfer}:colormatrix=bt2020nc",
                         "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc"]


SOURCES = {"sdr": PROFILES["1080p-h264"], "hlg": hdr_profile("arib-std-b67", "arib-std-b67"),
           "pq": hdr_profile("smpte2084", "smpte2084")}
STATS = ("YAVG", "YLOW", "YHIGH", "SATAVG")
_STAT = re.compile(r"lavfi\.signalstats\.(YAVG|YLOW|YHIGH|SATAVG)=(\d+(?:\.\d+)?)")
Y_RANGE = (40.0, 200.0)
MIN_RATIO = 0.5


def make_clip(path: Path, source: str, seconds: int) -> None:
    size, video = SOURCES[source]
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}", *video, "-an", str(path)],
        timeout_s=seconds * 60)


def stats(path: Path) -> dict[str, float]:
    """متوسط إحصاءات signalstats على كل الإطارات (8 بت)."""
    out = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
               "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], timeout_s=600).decode()
    acc: dict[str, list[float]] = {k: [] for k in STATS}
    for key, value in _STAT.findall(out):
        acc[key].append(float(value))
    return {k: round(sum(v) / len(v), 1) for k, v in acc.items()}


def naive(src: Path, dst: Path) -> object:
    """ضابط سلبي: تحويل إلى 8 بت بوسوم BT.709 بلا خريطة ألوان، كما يفعل مسار يتجاهل HDR."""
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-an",
         "-vf", "scale=-2:480,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", str(dst)], timeout_s=600)
    return probe(dst)


def collapsed(s: dict[str, float], ref: dict[str, float]) -> list[str]:
    bad = []
    if not Y_RANGE[0] <= s["YAVG"] <= Y_RANGE[1]:
        bad.append("luma_level")
    if s["YHIGH"] - s["YLOW"] < MIN_RATIO * (ref["YHIGH"] - ref["YLOW"]):
        bad.append("luma_range")
    if s["SATAVG"] < MIN_RATIO * ref["SATAVG"]:
        bad.append("saturation")
    return bad


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    started, metrics, failures = now(), {}, []
    refs: dict[str, dict[str, float]] = {}
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        for source in SOURCES:
            src = d / f"{source}.mov"
            make_clip(src, source, args.seconds)
            info = probe(src)
            metrics[f"{source}_source_hdr"] = info.hdr
            metrics[f"{source}_source_transfer"] = info.color_transfer or "unset"
            for path in ("proxy", "produced") + (("naive",) if info.hdr else ()):
                out = d / f"{source}-{path}.mp4"
                t = time.perf_counter()
                if path == "proxy":
                    made = make_proxy(src, out, info)
                elif path == "naive":
                    made = naive(src, out)
                else:
                    made = render(src, out, info, [Segment(info.start_pts_us,
                                                           info.start_pts_us + info.duration_ms * 1000)])
                elapsed = time.perf_counter() - t
                s = stats(out)
                if source == "sdr":
                    refs[path] = s
                tags = [made.color_primaries, made.color_transfer, made.color_space]
                bad = [] if source == "sdr" else collapsed(s, refs["proxy" if path == "naive" else path])
                sdr_tags = made.hdr is False and (source == "sdr" or tags == ["bt709"] * 3)
                if not sdr_tags:
                    bad.append("tags")
                if path == "naive":  # الضابط السلبي: إن لم يكشفه المقياس فالمقياس لا يميّز
                    failures += [] if bad else [f"{source}-naive:not_detected"]
                else:
                    failures += [f"{source}-{path}:{b}" for b in bad]
                p = f"{source}_{path}"
                metrics.update({f"{p}_s": round(elapsed, 2), f"{p}_hdr": made.hdr, f"{p}_bit_depth": made.bit_depth,
                                f"{p}_color_tags": "/".join(str(t) for t in tags),
                                **{f"{p}_{k.lower()}": v for k, v in s.items()}, f"{p}_collapsed": ",".join(bad) or "none"})
                print(p, {k: v for k, v in metrics.items() if k.startswith(p)})
    result = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "media-hdr-proxy-produced",
        "started_at": started, "ended_at": now(),
        # محتوى اصطناعي محوَّل إلى HLG/PQ، لا تصوير هاتف حقيقي
        "result": "pass" if not failures else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(args.seconds), "codec": "hevc", "vfr": False, "hdr": True},
        "metrics": {**metrics, "failures": ",".join(failures) or "none", "luma_level_min": Y_RANGE[0],
                    "luma_level_max": Y_RANGE[1],
                    "min_ratio_to_sdr_reference": MIN_RATIO, "ffmpeg_version": ffmpeg.version()},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
