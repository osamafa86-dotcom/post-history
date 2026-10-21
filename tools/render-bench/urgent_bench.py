"""اختبار القبول «تصدير القالب العاجل»: تركيب طبقات الهوية على مقطع دقيقتين 1080p في زمن أقل من مدة المقطع.

المسار المعتمد: طبقات Remotion قصيرة بقناة شفافية (ProRes 4444، `urgent_template/`) يركّبها FFmpeg فوق الفيديو، بين
مقدمة وخاتمة جاهزتين، في ترميز واحد. المسار الاحتياطي: libass بالنصوص والتوقيتات نفسها وبالخط نفسه (Noto Naskh Arabic
من الحزمة). يُقاس زمن كل مسار من البدء إلى ملف جاهز، وزمن رسم طبقات Remotion يُمرَّر من خطوة Node.

    python tools/render-bench/urgent_bench.py --overlays /tmp/ut --font-dir <مجلد woff> \\
        --remotion-render-s 35 --out docs/measurements/render-bench/<date>-urgent-template.json
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from media_worker import ffmpeg
from media_worker.ffmpeg import FFMPEG, run
from media_worker.probe import probe

SECONDS = 120
LOWER_AT, BREAKING_AT = 8.0, 0.5
NAME, ROLE, LABEL = "مراسل الشبكة", "غزة، بث مباشر", "عاجل"
ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart"]
ASS = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Name,Noto Naskh Arabic,64,&H00FFFFFF,&H00FFFFFF,&H001B00B3,&H001B00B3,1,0,0,0,100,100,0,0,3,14,0,3,0,90,170,0
Style: Role,Noto Naskh Arabic,40,&H00FFFFFF,&H00FFFFFF,&H26101010,&H26101010,0,0,0,0,100,100,0,0,3,10,0,3,0,90,95,0
Style: Breaking,Noto Naskh Arabic,56,&H00FFFFFF,&H00FFFFFF,&H000A0AD1,&H000A0AD1,1,0,0,0,100,100,0,0,3,12,0,9,0,70,70,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,{b0},{b1},Breaking,,0,0,0,,{label}
Dialogue: 0,{l0},{l1},Name,,0,0,0,,{{\\fad(300,300)}}{name}
Dialogue: 0,{l0},{l1},Role,,0,0,0,,{{\\fad(300,300)}}{role}
"""


def _ts(s: float) -> str:
    return f"{int(s // 3600)}:{int(s // 60 % 60):02d}:{s % 60:05.2f}"


def make_inputs(d: Path) -> tuple[Path, Path, Path]:
    main = d / "main.mp4"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={SECONDS}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SECONDS}",
         "-vf", "noise=alls=8:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "17M", "-g", "30",
         "-pix_fmt", "yuv420p", "-c:a", "aac", str(main)], timeout_s=1200)
    clips = []
    for name, color in (("intro", "0x7a0010"), ("outro", "0x101010")):
        p = d / f"{name}.mp4"
        run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", f"color={color}:s=1920x1080:r=30:d=3",
             "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=3", "-c:v", "libx264", "-preset", "ultrafast",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(p)], timeout_s=120)
        clips.append(p)
    return clips[0], main, clips[1]


def _concat(body: str) -> str:
    # مقدمة وخاتمة جاهزتان حول الجسم المركّب، في مرور ترميز واحد
    return (f"{body};[0:v][0:a][main][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]")


def remotion_path(intro: Path, main: Path, outro: Path, overlays: Path, out: Path) -> float:
    body = (f"[3:v]setpts=PTS+{BREAKING_AT}/TB[br];[4:v]setpts=PTS+{LOWER_AT}/TB[lt];"
            f"[1:v][br]overlay=eof_action=pass[m1];[m1][lt]overlay=eof_action=pass[main]")
    t = time.perf_counter()
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(intro), "-i", str(main),
         "-i", str(outro), "-i", str(overlays / "breaking.mov"), "-i", str(overlays / "lower.mov"),
         "-filter_complex", _concat(body), "-map", "[v]", "-map", "[a]", *ENCODE, str(out)], timeout_s=1800)
    return time.perf_counter() - t


def libass_path(intro: Path, main: Path, outro: Path, font_dir: Path, out: Path, d: Path) -> float:
    ass = d / "overlay.ass"
    ass.write_text(ASS.format(b0=_ts(BREAKING_AT), b1=_ts(BREAKING_AT + 4), l0=_ts(LOWER_AT), l1=_ts(LOWER_AT + 6),
                              name=NAME, role=ROLE, label=LABEL), encoding="utf-8")
    body = f"[1:v]ass=filename={ass}:fontsdir={font_dir}:shaping=complex[main]"
    t = time.perf_counter()
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(intro), "-i", str(main),
         "-i", str(outro), "-filter_complex", _concat(body), "-map", "[v]", "-map", "[a]", *ENCODE, str(out)],
        timeout_s=1800, cwd=d)
    return time.perf_counter() - t


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--overlays", type=Path, required=True)
    ap.add_argument("--font-dir", type=Path, required=True)
    ap.add_argument("--remotion-render-s", type=float, required=True)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--frames", type=Path, help="يحفظ إطارًا من كل مسار للمقارنة البصرية")
    args = ap.parse_args()
    started = now()
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        intro, main_clip, outro = make_inputs(d)
        r_out, a_out = d / "remotion.mp4", d / "libass.mp4"
        r_s = remotion_path(intro, main_clip, outro, args.overlays, r_out)
        a_s = libass_path(intro, main_clip, outro, args.font_dir, a_out, d)
        dur = probe(r_out).duration_ms / 1000
        if args.frames:
            for name, f in (("remotion", r_out), ("libass", a_out)):
                run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(3 + LOWER_AT + 2),
                     "-i", str(f), "-frames:v", "1", "-vf", "scale=960:-1", str(args.frames / f"{name}.png")], 60)
    metrics = {
        "clip_duration_s": round(dur, 2), "remotion_overlay_render_s": args.remotion_render_s,
        "remotion_composite_export_s": round(r_s, 2), "libass_export_s": round(a_s, 2),
        "remotion_total_s": round(args.remotion_render_s + r_s, 2),
        "remotion_composite_ratio": round(r_s / dur, 3), "libass_ratio": round(a_s / dur, 3),
        "encoder": "libx264 veryfast crf20 (CPU)", "ffmpeg_version": ffmpeg.version(),
    }
    ok = r_s < dur
    record = {
        "schema_version": 1, "tool": "other", "role": "media", "test_name": "urgent-template-export",
        "started_at": started, "ended_at": now(),
        # المعيار على «خادم التصدير المعتمد» (NVENC)؛ هذا قياس معالج مركزي، فالنتيجة جزئية حتى يُقاس هناك
        "result": "partial" if ok else "fail",
        "device": {"platform": "server", "model": f"{os.cpu_count()} vCPU, no GPU"}, "upload_path": "n/a",
        "file": {"duration_s": float(SECONDS), "codec": "h264", "vfr": False, "hdr": False},
        "metrics": metrics,
    }
    if args.out:
        args.out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
