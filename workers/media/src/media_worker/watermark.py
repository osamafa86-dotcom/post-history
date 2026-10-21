"""معاينة المتجر (`watermarked_preview`، عقد v0.3، ADR 0025): نسخة منخفضة بعلامة مائية مرئية، ملف جديد من الأصل.

- الدقة: الضلع القصير 360 ومعدل بت محدود، فلا تصلح بديلًا عن النسخة المرخّصة.
- العلامة: أشرطة قطرية نصف شفافة على كامل الإطار، تُحرق في الصورة نفسها (لا مسار منفصل يُحذف)، فلا يزيلها قص الإطار.
  نص بالعلامة التجارية يحتاج خطًا عربيًا في الصورة، ويُضاف حين يُعتمد.
- بلا وسوم ولا فصول، و`-copyts` يحفظ خط زمن الأصل كالنسخة الخفيفة. HDR يُحوَّل إلى SDR بالسلسلة نفسها.
- المدخل مقيد بـ `INPUT_GUARD`، والأصل يُقرأ فقط.
"""

from __future__ import annotations

import os
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe, probe
from .proxy import SDR_TAGS, video_filter

PREVIEW_SHORT_SIDE = 360
# عرض الشريط ودورته بالبكسل على إطار 360p؛ الشريط يرفع الإضاءة ويخفض التباين فيبقى المحتوى مقروءًا للتقييم
STRIPE, PERIOD = 18, 72
WATERMARK = (f"geq=lum='if(lt(mod(X+Y\\,{PERIOD})\\,{STRIPE})\\,lum(X\\,Y)*0.55+110\\,lum(X\\,Y))'"
             ":cb='cb(X\\,Y)':cr='cr(X\\,Y)'")


def preview_args(src: Path, dst: Path, source: Probe) -> list[str]:
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        *INPUT_GUARD, "-copyts", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
        "-vf", f"{video_filter(source, PREVIEW_SHORT_SIDE)},{WATERMARK}", "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "700k", "-bufsize", "1400k",
        "-profile:v", "main", "-pix_fmt", "yuv420p", *(SDR_TAGS if source.hdr else []),
        "-c:a", "aac", "-b:a", "64k", "-ac", "2",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-movflags", "+faststart", "-f", "mp4", str(dst),
    ]


def make_watermarked_preview(src: Path, dst: Path, source: Probe) -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("preview output must be a new file, never the original")
    if source.video_codec is None:
        raise ValueError("no video stream: the store preview is for video only")
    partial = dst.with_name(dst.name + ".partial")
    try:
        run(preview_args(src, partial, source), max(120.0, source.duration_ms / 1000 * 4), cwd=partial.parent)
        result = probe(partial)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
