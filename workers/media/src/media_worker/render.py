"""التصدير النهائي: مقاطع من الأصل بجودته الكاملة بنقاط قص على خط زمن المصدر، في ملف H.264 واحد.

- نقاط القص بزمن المصدر المطلق (`start_pts` محفوظ؛ `-copyts` يبقي طوابع الأصل في المرشحات)، فتطابق ما اختاره
  المحرر على النسخة الخفيفة التي تحفظ الطوابع نفسها. القص بفك الإطارات (`trim`/`atrim`) لا عند الإطارات المفتاحية.
- كل مقطع يبدأ في الناتج عند مجموع أطوال المقاطع السابقة الاسمية (b − a) تمامًا: الصورة تُختار وتُزاح بتعبير واحد
  (`select` و`setpts`)، والصوت يُقص لكل مقطع بدقة العينة ثم يوصل. لا يُترك طول المقطع لمدد الإطارات (غير منتظمة في
  المعدل المتغير)، فلا ينزاح القص ولا التزامن مع تعدد المقاطع. المقاطع متصاعدة غير متداخلة.
- الاتجاه: دوران العرض يُطبَّق قبل المرشحات. HDR يُحوَّل إلى SDR BT.709 بالسلسلة نفسها، وبكسل مربع، و8 بت 4:2:0.
- بلا وسوم ولا فصول ولا رسالة SEI (ولا ما يكتبه المرمّز نفسه)، و`faststart`.
- المرمّز: libx264 (CRF 18). NVENC حين تحويه نسخة ffmpeg (`h264_nvenc`)؛ الصورة الحالية الساكنة لا تحويه.
- المدخل مقيد بـ `INPUT_GUARD`، والأصل يُقرأ فقط، والمخرج باسم مؤقت ثم نقل ذري.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe, probe
from .proxy import SDR_TAGS, video_filter

ENCODERS = {
    "libx264": ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"],
    "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0",
                   "-profile:v", "high"],
}


@dataclass(frozen=True)
class Segment:
    """مقطع على خط زمن المصدر بالميكروثانية: [start_us، end_us)."""
    start_us: int
    end_us: int


def available_encoder(prefer_gpu: bool) -> str:
    if prefer_gpu and b"h264_nvenc" in run([FFMPEG, "-hide_banner", "-encoders"], timeout_s=30):
        return "h264_nvenc"
    return "libx264"


def render_args(src: Path, dst: Path, source: Probe, segments: list[Segment], encoder: str) -> list[str]:
    vf = video_filter(source, 100_000)  # لا تكبير: الضلع القصير الكامل
    audio = source.audio_codec is not None
    spans, acc = [], 0.0
    for s in segments:
        a, b = s.start_us / 1e6, s.end_us / 1e6
        spans.append((a, b, acc))
        acc += b - a
    keep = "+".join(f"gte(t\\,{a:.6f})*lt(t\\,{b:.6f})" for a, b, _ in spans)
    # الطابع الجديد: نسبةً إلى نقطة القص لا إلى أول إطار بعدها، مزاحًا بمجموع ما قبله
    shift = f"T-{spans[-1][0]:.6f}+{spans[-1][2]:.6f}"
    for a, b, off in reversed(spans[:-1]):
        shift = f"if(lt(T\\,{b:.6f})\\,T-{a:.6f}+{off:.6f}\\,{shift})"
    graph = [f"[0:v:0]select='{keep}',setpts='({shift})/TB',{vf}[v]"]
    if audio:
        for i, (a, b, _) in enumerate(spans):
            graph.append(f"[0:a:0]atrim=start={a:.6f}:end={b:.6f},asetpts=PTS-STARTPTS[a{i}]")
        graph.append("".join(f"[a{i}]" for i in range(len(spans))) + f"concat=n={len(spans)}:v=0:a=1[a]")
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        *INPUT_GUARD, "-copyts", "-i", str(src),
        "-filter_complex", ";".join(graph), "-map", "[v]", *(["-map", "[a]"] if audio else []),
        "-map_metadata", "-1", "-map_chapters", "-1", "-fps_mode", "vfr",
        *ENCODERS[encoder], "-pix_fmt", "yuv420p", *(SDR_TAGS if source.hdr else []),
        # رسالة SEI التي يكتبها المرمّز نفسه (اسمه وخياراته) تُحذف، و`bitexact` لا يكتب اسم الجامع ولا توقيتًا
        "-bsf:v", "filter_units=remove_types=6",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        *(["-c:a", "aac", "-b:a", "192k"] if audio else []),
        "-movflags", "+faststart", "-f", "mp4", str(dst),
    ]


def render(src: Path, dst: Path, source: Probe, segments: list[Segment], encoder: str = "libx264") -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("export output must be a new file, never the original")
    if source.video_codec is None:
        raise ValueError("no video stream")
    lo, hi = source.start_pts_us, source.start_pts_us + source.duration_ms * 1000
    if not segments or any(not (lo <= s.start_us < s.end_us <= hi + 1000) for s in segments):
        raise ValueError("segments must be non-empty and inside the source timeline")
    if any(b.start_us < a.end_us for a, b in zip(segments, segments[1:])):
        raise ValueError("segments must be ascending and must not overlap")
    total_s = sum(s.end_us - s.start_us for s in segments) / 1e6
    partial = dst.with_name(dst.name + ".partial")
    try:
        run(render_args(src, partial, source, segments, encoder), max(300.0, total_s * 10), cwd=partial.parent)
        result = probe(partial)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
