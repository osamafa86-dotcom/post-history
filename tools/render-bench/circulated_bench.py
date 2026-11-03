"""قياس نسخة قالب «مواد متداولة» (ADR 0091 البند 7) على مقاطع اصطناعية، بالمسار نفسه الذي يسلكه العامل
(`media_worker.circulated.make_circulated`): طبقة Remotion القصيرة بالمتصفح المثبّت، ثم تركيب FFmpeg.

لكل حالة: مصدر بعلامات تزامن (`av_sync`: ومضة ونبضة كل ثانيتين) ووسوم كاشفة مزروعة (ISO 6709 وطراز الجهاز)، ونصّ
محايد. المقاييس:

- زمن الطبقة، وزمن التركيب، والمجموع ونسبته إلى المدة (المعيار ≤ 1 لحالتي 30 ث و120 ث).
- ذروة الذاكرة: `memory.peak` للحاوية إن قُرئ، وأكبر RSS لعملية فرعية؛ وذروة القرص المؤقت (المصدر والطبقة والناتج).
- اللون: `yuv420p` بنطاق tv وBT.709 في كل الحالات، ومنها النطاق الكامل وHLG. المعدل 25 للمصدر 25 وإلا 30.
- المدة ± إطار، والتزامن ≤ 40 ms، والإطارات بعدّها، وصفر من القيم المزروعة في بايتات الناتج.
- التكافؤ عند 25 و30: الطبقة المجمّعة (دخول ودورة مكرّرة وخروج) مطابقة لرسم كامل إطارًا بإطار (`framemd5`).
- VMAF (إن حوته نسخة ffmpeg): نسخة ضابطة بلا طبقة بالملاءمة والترميز نفسهما مقابل السلسلة نفسها بلا فقد (≥ 93).

النتيجة `partial` دائمًا حتى يُقاس على مواصفة خادم التجربة (8 vCPU و32 GB). داخل صورة `render`:

    docker run --rm --network none -v "$PWD/tools/render-bench:/bench:ro" -v /tmp/cr:/out \\
      -e PYTHONPATH=/app/src:/bench --entrypoint python media-worker:render /bench/circulated_bench.py --quick \\
      --out /out/circulated.json
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import av_sync
from av_sync import THRESHOLD_MS, Case, make_source
from media_worker import ffmpeg
from media_worker.circulated import (PRESET, SIZES, OverlayPlan, OverlayRenderer, Piece, RenderJob, composite_args,
                                     composite_graph, make_circulated, output_fps, plan_overlay)
from media_worker.ffmpeg import FFMPEG, FFPROBE, run
from media_worker.probe import probe

# قيم غير واقعية عمدًا كما في اختبارات العامل
PLANTED = {"com.apple.quicktime.location.ISO6709": "+00.0001+000.0001+000.000/",
           "com.apple.quicktime.make": "BenchMaker", "com.apple.quicktime.model": "BenchPhone 9"}
TITLE = ["عنوان تجريبي", "للمادة المتداولة"]


@dataclass(frozen=True)
class CircCase:
    name: str
    source: Case
    aspect: str
    full_range: bool = False
    rotate: int = 0


QUICK = (
    CircCase("30s-1080p30-vertical", Case("src-1080p30", 30), "vertical"),
    CircCase("30s-1080p30-horizontal", Case("src-1080p30", 30), "horizontal"),
    CircCase("30s-1080p30-square", Case("src-1080p30", 30), "square"),
    CircCase("30s-720p-phone-vfr-vertical", Case("src-720p-vfr", 30, size="1280x720", vfr=True, start_offset=1.5),
             "vertical", rotate=90),
    CircCase("30s-1080p25-vertical", Case("src-1080p25", 30, rate=25), "vertical"),
    CircCase("30s-1080p30-fullrange-vertical", Case("src-1080p30", 30), "vertical", full_range=True),
    CircCase("20s-1080p30-hlg-vertical", Case("src-hlg", 20, start_offset=1.5, hdr_transfer="arib-std-b67"),
             "vertical"),
)
FULL = QUICK + (
    CircCase("120s-1080p30-vertical", Case("src-1080p30-120", 120), "vertical"),
    CircCase("300s-1080x1920-vertical", Case("src-1080x1920-300", 300, size="1080x1920"), "vertical"),
)


class TimedRenderer:
    """يغلّف مرسم الطبقة ليقيس زمنها وحجم قطعها، دون أن يغيّر ما يُرسل إليه."""

    def __init__(self, inner: OverlayRenderer) -> None:
        self.inner = inner
        self.seconds = 0.0
        self.bytes = 0

    def render(self, job: RenderJob, plan: OverlayPlan, workdir: Path, timeout_s: float) -> list[Path]:
        t0 = time.perf_counter()
        outs = self.inner.render(job, plan, workdir, timeout_s)
        self.seconds = time.perf_counter() - t0
        self.bytes = sum(o.stat().st_size for o in outs)
        return outs


def job_for(aspect: str, render_id: str = "00000000-0000-4000-8000-000000000091") -> RenderJob:
    return RenderJob(render_id=render_id, material_id="00000000-0000-4000-8000-000000000001",
                     source_file_id="00000000-0000-4000-8000-000000000002", state="rendering",
                     template="circulated", aspect=aspect, title_lines=tuple(TITLE), location_text="مدينة، محافظة",
                     label="circulated_footage")


def build_source(c: CircCase, work: Path) -> Path:
    raw = work / f"{c.source.name}.raw.mp4"
    if not raw.exists():
        make_source(c.source, raw)
    out = work / f"{c.source.name}-{'full' if c.full_range else 'tv'}-{c.rotate}.mov"
    if out.exists():
        return out
    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    if c.rotate:
        args += ["-display_rotation", str(c.rotate)]
    args += ["-i", str(raw), "-map", "0", "-movflags", "use_metadata_tags"]
    for k, v in PLANTED.items():
        args += ["-metadata", f"{k}={v}"]
    if c.full_range:
        args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuvj420p", "-color_range", "pc", "-c:a", "copy"]
    else:
        args += ["-c", "copy"]
    run([*args, str(out)], timeout_s=c.source.seconds * 10 + 120)
    return out


def stream_tags(path: Path) -> dict:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=pix_fmt,color_range,color_space,color_primaries,color_transfer,r_frame_rate,nb_frames",
               "-of", "json", str(path)], timeout_s=60)
    return json.loads(out)["streams"][0]


def cgroup_peak_mb() -> float | None:
    for p in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(Path(p).read_text().split()[0]) / 2**20, 1)
        except (OSError, ValueError):
            continue
    return None


def measure(c: CircCase, renderer: OverlayRenderer, work: Path, frames_dir: Path | None) -> dict:
    src = build_source(c, work)
    info = probe(src)
    timed = TimedRenderer(renderer)
    out = work / f"{c.name}.mp4"
    case_dir = work / f"job-{c.name}"
    case_dir.mkdir(exist_ok=True)
    t0 = time.perf_counter()
    made = make_circulated(src, out, info, job_for(c.aspect), timed, case_dir)  # type: ignore[arg-type]
    total = time.perf_counter() - t0
    seconds = info.duration_ms / 1000
    fps = output_fps(info)
    tags = stream_tags(out)
    W, H = SIZES[c.aspect]
    expected_frames = round(info.duration_ms * fps / 1000)
    blob = out.read_bytes()
    r = {
        "overlay_s": round(timed.seconds, 2),
        "composite_s": round(total - timed.seconds, 2),
        "total_s": round(total, 2),
        "total_to_duration": round(total / seconds, 3),
        "out_fps": fps,
        "out_mbps": round(len(blob) * 8 / seconds / 1e6, 2),
        "scratch_peak_mb": round((src.stat().st_size + timed.bytes + len(blob)) / 1e6, 1),
        "overlay_pieces_mb": round(timed.bytes / 1e6, 1),
        "colour_ok": (tags.get("pix_fmt"), tags.get("color_range"), tags.get("color_space"),
                      tags.get("color_primaries"), tags.get("color_transfer")) == ("yuv420p", "tv", "bt709", "bt709",
                                                                                   "bt709"),
        "size_ok": (made.width, made.height) == (W, H),
        "frames": made.frame_count,
        "frames_ok": abs((made.frame_count or 0) - expected_frames) <= 1 and tags.get("r_frame_rate") == f"{fps}/1",
        "duration_drift_ms": abs(made.duration_ms - info.duration_ms),
        "planted_values_found": sum(v.encode() in blob for v in PLANTED.values()),
        "audio": f"{made.audio_codec}/{made.audio_sample_rate}/{made.audio_channels}",
    }
    sync = av_sync.compare(src, out, seconds * 10 + 120)
    r["marks"] = sync["marks_proxy"]
    r["av_offset_added_ms_max"] = sync["av_offset_added_ms_max"]
    r["video_mark_shift_ms_max"] = sync["video_mark_shift_ms_max"]
    if frames_dir is not None:
        frames_dir.mkdir(parents=True, exist_ok=True)
        for at in (0.3, 0.8, 1.6, round(seconds / 2, 2), round(seconds - 0.3, 2)):
            run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(at), "-i", str(out),
                 "-frames:v", "1", str(frames_dir / f"{c.name}-{at:.2f}s.png")], timeout_s=60)
    # الزمن يتبع المواصفة فيُسجَّل وحده (المعيار على خادم التجربة)، والصحة تحكم pass في أي بيئة
    r["within_duration"] = r["total_to_duration"] <= 1.0
    r["pass"] = (r["colour_ok"] and r["size_ok"] and r["frames_ok"] and r["planted_values_found"] == 0
                 and r["duration_drift_ms"] <= 1000 / fps + 1 and r["av_offset_added_ms_max"] <= THRESHOLD_MS
                 and r["marks"] > 0)
    out.unlink()
    return r


def framemd5(args: list[str]) -> list[str]:
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", *args, "-f", "framemd5", "-"],
              timeout_s=900).decode()
    return [line.rsplit(",", 1)[-1].strip() for line in raw.splitlines() if line and not line.startswith("#")]


def parity(renderer: OverlayRenderer, fps: int, seconds: int, work: Path) -> dict:
    """الطبقة المجمّعة مقابل رسم كامل لخط الزمن نفسه، إطارًا بإطار بعد الفك (yuva444p12le كما خرجت)."""
    d = work / f"parity-{fps}"
    d.mkdir(exist_ok=True)
    short = plan_overlay(seconds * 1000, fps)
    full = OverlayPlan(fps, short.frames, (Piece(0, short.frames - 1),))
    job = job_for("vertical")
    pieces = renderer.render(job, short, d, timeout_s=1800)
    # التجميع نفسه الذي يركّبه العامل: الدورة من الذاكرة بين الدخول والخروج. البصمات أولًا ثم تُحذف القطع، فلا تجتمع
    # الطبقتان على القرص
    period = short.pieces[1].frames
    graph = (f"[1:v]loop=loop=-1:size={period}:start=0,trim=end_frame={short.fill},setpts=PTS-STARTPTS[mid];"
             "[0:v][mid][2:v]concat=n=3:v=1:a=0[ov]")
    assembled = framemd5(["-i", str(pieces[0]), "-i", str(pieces[1]), "-i", str(pieces[2]),
                          "-filter_complex", graph, "-map", "[ov]", "-pix_fmt", "yuva444p12le"])
    for p in pieces:
        p.unlink(missing_ok=True)
    (whole,) = renderer.render(job, full, d, timeout_s=3600)
    reference = framemd5(["-i", str(whole), "-pix_fmt", "yuva444p12le"])
    whole.unlink(missing_ok=True)
    mismatched = sum(a != b for a, b in zip(assembled, reference)) + abs(len(assembled) - len(reference))
    return {"frames": len(reference), "mismatched_frames": mismatched, "pass": mismatched == 0 and len(reference) > 0}


def vmaf(aspect: str, seconds: int, work: Path) -> dict:
    """نسخة ضابطة بلا طبقة بالترميز نفسه، مقابل السلسلة نفسها بلا فقد (libx264 بـ qp 0)، على محتوى متحرك مفصّل
    (testsrc2 بجودة عالية) لا على علامات التزامن السوداء والبيضاء."""
    if b" libvmaf " not in run([FFMPEG, "-hide_banner", "-filters"], timeout_s=30):
        return {"available": False}
    src = work / "vmaf-src.mp4"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"testsrc2=size=1920x1080:rate=30:duration={seconds}", "-c:v", "libx264", "-preset", "fast", "-crf", "12",
         "-pix_fmt", "yuv420p", str(src)], timeout_s=seconds * 20 + 120)
    info = probe(src)
    plan = plan_overlay(info.duration_ms, output_fps(info))
    control, lossless = work / "control.mp4", work / "lossless.mkv"
    run(composite_args(src, [], control, info, aspect, plan), timeout_s=1800)
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
         "-filter_complex", composite_graph(info, aspect, plan, overlay=False), "-map", "[v]",
         "-frames:v", str(plan.frames), "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", str(lossless)],
        timeout_s=1800)
    log = work / "vmaf.json"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(control), "-i", str(lossless),
         # الإطارات تُقرن بترتيبها لا بطوابعها: طوابع Matroska بالملّي ثانية تقرن إطارًا من كل ثلاثة بسابقه عند 30
         "-lavfi", f"[0:v]setpts=N/{plan.fps}/TB[d];[1:v]setpts=N/{plan.fps}/TB[r];[d][r]libvmaf=log_fmt=json:"
                   f"log_path={log.name}:n_threads={os.cpu_count() or 4}", "-f", "null", "-"],
        timeout_s=3600, cwd=work)
    mean = json.loads(log.read_text())["pooled_metrics"]["vmaf"]["mean"]
    for p in (control, lossless, log, src):
        p.unlink(missing_ok=True)
    return {"available": True, "mean": round(mean, 2), "pass": mean >= 93}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--quick", action="store_true", help="حالات 30 ث و20 ث وحدها (CI)")
    ap.add_argument("--cases", nargs="*")
    ap.add_argument("--parity-seconds", type=int, default=20)
    ap.add_argument("--no-parity", action="store_true")
    ap.add_argument("--no-vmaf", action="store_true")
    ap.add_argument("--frames-dir", type=Path)
    ap.add_argument("--env-label", default="")
    ap.add_argument("--strict", action="store_true", help="يخرج بغير الصفر إن فشل فحص صحة (لا الزمن)")
    args = ap.parse_args()
    cases = [c for c in (QUICK if args.quick else FULL) if not args.cases or c.name in args.cases]
    renderer = OverlayRenderer.from_env(dict(os.environ))
    if missing := renderer.missing():
        raise SystemExit(f"render image incomplete: {', '.join(missing)}")

    started = now()
    metrics: dict[str, float | str | bool | int] = {
        "ffmpeg_version": ffmpeg.version(), "threshold_ms": THRESHOLD_MS, "cases_run": len(cases),
        "remotion_version": "4.0.537", "browser": "chrome-headless-shell 157.0.8080.0 (pinned in the image)",
        "x264_preset": PRESET,
        "render_concurrency": renderer.concurrency or "remotion-default",
    }
    passes = []
    with tempfile.TemporaryDirectory(dir=os.environ.get("MEDIA_SCRATCH_DIR")) as tmp:
        work = Path(tmp)
        for c in cases:
            r = measure(c, renderer, work, args.frames_dir)
            passes.append(r["pass"])
            for k, v in r.items():
                metrics[f"{c.name.replace('-', '_')}__{k}"] = v
            print(json.dumps({"case": c.name, **r}, ensure_ascii=False), flush=True)
        if not args.no_parity:
            for fps in (30, 25):
                p = parity(renderer, fps, args.parity_seconds, work)
                passes.append(p["pass"])
                for k, v in p.items():
                    metrics[f"parity_{fps}fps_{args.parity_seconds}s__{k}"] = v
                print(json.dumps({"parity_fps": fps, **p}), flush=True)
        if not args.no_vmaf:
            v = vmaf("vertical", 30, work)
            passes.extend([v["pass"]] if v.get("available") else [])
            for k, val in v.items():
                metrics[f"vmaf_30s_testsrc_vertical__{k}"] = val
            print(json.dumps({"vmaf": v}), flush=True)
    peak = cgroup_peak_mb()
    if peak is not None:
        metrics["container_memory_peak_mb"] = peak
    metrics["max_child_rss_mb"] = round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024, 1)
    metrics["all_checks_pass"] = all(passes)
    out = {
        "schema_version": 1, "tool": "render-bench", "role": "media", "test_name": "circulated-render",
        "started_at": started, "ended_at": now(),
        # partial حتى يُقاس على مواصفة خادم التجربة (ADR 0091 البند 7)، أيًّا كانت نتيجة هذه البيئة
        "result": "partial",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU {args.env_label}".strip()},
        "upload_path": "n/a",
        "metrics": metrics,
        "notes": ("مقاطع اصطناعية بعلامات تزامن ووسوم مزروعة ونصّ محايد عبر make_circulated نفسه (طبقة Remotion القصيرة "
                  "ثم تركيب FFmpeg). partial حتى القياس على مواصفة خادم التجربة (8 vCPU و32 GB) وحالتي 120 ث و300 ث "
                  "والفحص البصري لدور التصميم. الأمر: python tools/render-bench/circulated_bench.py داخل صورة "
                  "workers/media بهدف render."),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print("MEASUREMENT " + json.dumps(out, ensure_ascii=False), flush=True)
    if args.strict and not metrics["all_checks_pass"]:
        raise SystemExit("a correctness check failed")


if __name__ == "__main__":
    main()
