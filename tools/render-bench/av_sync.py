"""قياس تزامن الصوت والصورة في النسخة الخفيفة (التذكرة 2 للوسائط).

لكل حالة: مقطع اصطناعي بعلامات تزامن معروفة (ومضة بيضاء في الصورة ونبضة 1 kHz في الصوت في اللحظة نفسها، كل
ثانيتين بدءًا من الثانية الأولى)، يمر عبر خط النسخة الخفيفة نفسه (`media_worker.proxy.make_proxy`)، ثم تُكشف
العلامات في المصدر وفي الناتج من ffmpeg واحد لكل ملف (`-copyts`، فالصورة والصوت على خط زمني واحد):

- الصورة: زمن أول إطار في كل ومضة (`signalstats` YAVG > 128).
- الصوت: بداية كل نبضة بدقة العينة (`silencedetect`، نهاية الصمت).

المقاييس، والمعيار 40 ms لكل منها:
- إزاحة صوت/صورة في الناتج لكل علامة، منسوبة إلى الإزاحة نفسها في المصدر (ما يضيفه الخط وحده).
- انزياح العلامات بين المصدر والناتج (صورة وصوت).
- انحراف المدة بين المصدر والناتج.

لا ملفات حقيقية ولا مزوّد خارجي. القراءة بالتحصين نفسه (`INPUT_GUARD`، `-nostdin`، بيئة نظيفة).

    PYTHONPATH=workers/media/src python tools/render-bench/av_sync.py \
        --out docs/measurements/media/<date>-proxy-av-sync.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.ffmpeg import FFMPEG, INPUT_GUARD, run
from media_worker.probe import probe
from media_worker.proxy import make_proxy

THRESHOLD_MS = 40.0
MARK_PERIOD_S = 2
MARK_FIRST_S = 1
BEEP_S = 0.02
FLASH_FRAMES = 2


@dataclass(frozen=True)
class Case:
    name: str
    seconds: int
    size: str = "1920x1080"
    rate: int = 30
    vfr: bool = False
    start_offset: float = 0.0


CASES = (
    Case("10s-1080p30", 10),
    Case("120s-1080p30", 120),
    # كما تسجّل الهواتف: معدل متغير وبداية غير صفرية
    Case("10s-1080p30-vfr-offset", 10, vfr=True, start_offset=3.5),
)


def make_source(case: Case, path: Path) -> None:
    flash = FLASH_FRAMES / case.rate
    on = f"lt(mod(t-{MARK_FIRST_S}\\,{MARK_PERIOD_S})\\,{{d}})*gte(t\\,{MARK_FIRST_S})"
    video = (f"color=black:s={case.size}:r={case.rate}:d={case.seconds}[b];"
             f"color=white:s={case.size}:r={case.rate}:d={case.seconds}[w];"
             f"[b][w]overlay=enable='{on.format(d=flash - 0.001)}'")
    if case.vfr:
        # يسقط إطارًا من كل سبعة خارج الومضة: فواصل غير منتظمة دون حذف العلامة
        video += f",select='not(eq(mod(n\\,7)\\,3))+{on.format(d=flash)}'"
    audio = f"aevalsrc='{on.format(d=BEEP_S)}*0.8*sin(2*PI*1000*t)':s=48000:d={case.seconds}"
    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", audio]
    if case.vfr:
        args += ["-fps_mode", "vfr"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", str(case.rate),
             "-c:a", "aac", "-b:a", "128k"]
    if case.start_offset:
        args += ["-output_ts_offset", str(case.start_offset)]
    args.append(str(path))
    run(args, timeout_s=case.seconds * 20 + 60)


_SILENCE_END = re.compile(r"silence_end: (-?\d+(?:\.\d+)?)")
_PTS = re.compile(r"pts_time:(-?\d+(?:\.\d+)?)")
_YAVG = re.compile(r"lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)")


def detect_marks(path: Path, timeout_s: float) -> tuple[list[float], list[float]]:
    """أزمنة العلامات (ثوانٍ على خط الملف الزمني) في الصورة وفي الصوت."""
    with tempfile.TemporaryDirectory() as tmp:
        vfile = Path(tmp) / "video.txt"
        proc_err = run_with_stderr([
            FFMPEG, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
            *INPUT_GUARD, "-copyts", "-i", str(path),
            "-filter_complex",
            f"[0:v]signalstats,metadata=print:key=lavfi.signalstats.YAVG:file={vfile.name};"
            "[0:a]silencedetect=noise=-30dB:d=0.3",
            "-f", "null", "-",
        ], timeout_s, cwd=tmp)
        video: list[float] = []
        pts, lit = None, False
        for line in vfile.read_text().splitlines():
            if m := _PTS.search(line):
                pts = float(m.group(1))
            elif (m := _YAVG.search(line)) and pts is not None:
                bright = float(m.group(1)) > 128
                if bright and not lit:
                    video.append(pts)
                lit = bright
    audio = [float(m.group(1)) for m in _SILENCE_END.finditer(proc_err)]
    return video, audio


def run_with_stderr(args: list[str], timeout_s: float, cwd: str) -> str:
    """مثل ffmpeg.run (بيئة نظيفة، stdin مغلق) لكنه يعيد stderr حيث يكتب silencedetect."""
    proc = subprocess.run(args, capture_output=True, timeout=timeout_s, check=False, env=ffmpeg.CHILD_ENV,
                          cwd=cwd, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise ffmpeg.MediaToolError(f"ffmpeg exited {proc.returncode}")
    return proc.stderr.decode("utf-8", "replace")


def _pairs(video: list[float], audio: list[float]) -> list[tuple[float, float]]:
    """يقرن كل علامة صورة بأقرب علامة صوت (أقل من نصف الدورة)."""
    out = []
    for v in video:
        a = min(audio, key=lambda x: abs(x - v), default=None)
        if a is not None and abs(a - v) < MARK_PERIOD_S / 2:
            out.append((v, a))
    return out


def compare(src: Path, out: Path, timeout_s: float) -> dict:
    """يقارن علامات المصدر بعلامات الناتج. كل المقاييس بالملّي ثانية."""
    sv, sa = detect_marks(src, timeout_s)
    pv, pa = detect_marks(out, timeout_s)
    src_pairs, out_pairs = _pairs(sv, sa), _pairs(pv, pa)
    n = min(len(src_pairs), len(out_pairs))
    pairs = list(zip(src_pairs[:n], out_pairs[:n]))
    # ما يضيفه الخط: إزاحة الناتج ناقص إزاحة المصدر لكل علامة
    added = [((oa - ov) - (sa_ - sv_)) * 1000 for (sv_, sa_), (ov, oa) in pairs]
    v_shift = [(ov - sv_) * 1000 for (sv_, _), (ov, _) in pairs]
    a_shift = [(oa - sa_) * 1000 for (_, sa_), (_, oa) in pairs]
    raw_out = [(oa - ov) * 1000 for ov, oa in out_pairs]

    def mx(xs: list[float]) -> float:
        return round(max((abs(x) for x in xs), default=float("nan")), 3)

    return {
        "marks_source": len(src_pairs),
        "marks_proxy": len(out_pairs),
        "av_offset_added_ms_max": mx(added),
        "av_offset_proxy_raw_ms_max": mx(raw_out),
        "video_mark_shift_ms_max": mx(v_shift),
        "audio_mark_shift_ms_max": mx(a_shift),
    }


def measure(case: Case, workdir: Path) -> dict:
    src, dst = workdir / f"{case.name}.mp4", workdir / f"{case.name}.proxy.mp4"
    make_source(case, src)
    t0 = time.perf_counter()
    out_probe = make_proxy(src, dst)
    proxy_s = time.perf_counter() - t0
    src_probe = probe(src)
    expected = len(range(MARK_FIRST_S, case.seconds, MARK_PERIOD_S))

    result = {"case": case.name, "marks_expected": expected,
              **compare(src, dst, case.seconds * 10 + 60),
              "duration_drift_ms": abs(out_probe.duration_ms - src_probe.duration_ms),
              "start_pts_delta_us": out_probe.start_pts_us - src_probe.start_pts_us,
              "proxy_s": round(proxy_s, 3)}
    complete = expected == result["marks_source"] == result["marks_proxy"]
    within = all(result[k] <= THRESHOLD_MS for k in (
        "av_offset_added_ms_max", "video_mark_shift_ms_max", "audio_mark_shift_ms_max", "duration_drift_ms"))
    result["complete"] = complete
    result["pass"] = complete and within
    return result


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cases", nargs="*", default=[c.name for c in CASES])
    args = ap.parse_args()
    selected = [c for c in CASES if c.name in args.cases]

    started = now()
    with tempfile.TemporaryDirectory() as tmp:
        results = [measure(c, Path(tmp)) for c in selected]
    ended = now()

    metrics: dict[str, float | str | bool] = {"threshold_ms": THRESHOLD_MS, "ffmpeg_version": ffmpeg.version(),
                                              "cases_run": len(results), "cases_defined": len(CASES)}
    for r in results:
        prefix = r["case"].replace("-", "_")
        for k, v in r.items():
            if k != "case":
                metrics[f"{prefix}__{k}"] = v
    full_set = len(results) == len(CASES)
    all_pass = all(r["pass"] for r in results)
    out = {
        "schema_version": 1,
        "tool": "render-bench",
        "role": "media",
        "test_name": "proxy-av-sync",
        "started_at": started,
        "ended_at": ended,
        # pass فقط إن قيست المجموعة كلها ونجحت كل حالة
        "result": "pass" if full_set and all_pass else ("fail" if not all_pass else "partial"),
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU"},
        "upload_path": "n/a",
        "metrics": metrics,
        "notes": ("مقاطع اصطناعية بعلامات تزامن (ومضة + نبضة 1 kHz كل ثانيتين) عبر make_proxy نفسه. "
                  "الإزاحة المضافة = (صوت − صورة) في الناتج ناقص المقدار نفسه في المصدر؛ المعيار 40 ms لها "
                  "ولانزياح العلامات ولانحراف المدة. الأمر: python tools/render-bench/av_sync.py داخل صورة "
                  "workers/media."),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps([asdict(c) | r for c, r in zip(selected, results)], indent=2))


if __name__ == "__main__":
    main()
