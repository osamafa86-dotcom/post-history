"""معاينة المتجر (`watermarked_preview`، عقد v0.3، ADR 0025): نسخة منخفضة بعلامة مائية مرئية، ملف جديد من الأصل.

- الدقة: الضلع القصير 360 ومعدل بت محدود، فلا تصلح بديلًا عن النسخة المرخّصة.
- العلامة: شبكة أشرطة قطرية في الاتجاهين **معتمة** على كامل الإطار، تُحرق في الصورة نفسها. ما تحت الشريط يُستبدل
  بلون ثابت فلا يُستعاد بأي تحويل (لا مزج نصف شفاف يُعكس)، ولا يزيلها قص الإطار.
- موضع الشبكة يُزاح لكل مادة بإزاحة مشتقة بـ HMAC من مفتاح سري في بيئة الخادم (`MEDIA_WATERMARK_KEY`، لا في
  المستودع) ومعرّف المادة، فلا يُبنى قناع عام واحد لكل المعاينات.
- نص بالعلامة التجارية يحتاج خطًا عربيًا في الصورة، ويُضاف حين يُعتمد.
- بلا وسوم ولا فصول، و`-copyts` يحفظ خط زمن الأصل كالنسخة الخفيفة. HDR يُحوَّل إلى SDR بالسلسلة نفسها.
- المدخل مقيد بـ `INPUT_GUARD`، والأصل يُقرأ فقط.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe, probe
from .proxy import SDR_TAGS, video_filter

PREVIEW_SHORT_SIDE = 360
# عرض الشريط ودورته بالبكسل على إطار 360p: شريطان من كل 64 بكسل في الاتجاهين يغطيان نحو 34% من الإطار، ويبقى
# ما بينهما مقروءًا لتقييم اللقطة
STRIPE, PERIOD = 12, 64
FILL_Y, FILL_C = 235, 128


def offsets(key: bytes, material_id: str) -> tuple[int, int]:
    if len(key) < 16:
        raise ValueError("MEDIA_WATERMARK_KEY must be at least 16 bytes")
    d = hmac.new(key, material_id.encode(), hashlib.sha256).digest()
    return d[0] % PERIOD, d[1] % PERIOD


def watermark_filter(ox: int, oy: int) -> str:
    """الشبكة على المستوى اللوني بإحداثيات مضاعفة (4:2:0) لتطابق شبكة الإضاءة، فيبقى الشريط معتمًا بلونه كله."""
    def band(x: str, y: str, h: str) -> str:
        return (f"lt(mod({x}+{y}+{ox}\\,{PERIOD})\\,{STRIPE})+"
                f"lt(mod({x}-{y}+{h}+{oy}\\,{PERIOD})\\,{STRIPE})")
    luma = band("X", "Y", "H")
    chroma = band("2*X", "2*Y", "2*H")
    return (f"geq=lum='if({luma}\\,{FILL_Y}\\,lum(X\\,Y))'"
            f":cb='if({chroma}\\,{FILL_C}\\,cb(X\\,Y))':cr='if({chroma}\\,{FILL_C}\\,cr(X\\,Y))'")


def preview_args(src: Path, dst: Path, source: Probe, ox: int, oy: int) -> list[str]:
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        *INPUT_GUARD, "-copyts", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
        "-vf", f"{video_filter(source, PREVIEW_SHORT_SIDE)},{watermark_filter(ox, oy)}", "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "700k", "-bufsize", "1400k",
        "-profile:v", "main", "-pix_fmt", "yuv420p", *(SDR_TAGS if source.hdr else []),
        "-c:a", "aac", "-b:a", "64k", "-ac", "2",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
        "-movflags", "+faststart", "-f", "mp4", str(dst),
    ]


def make_watermarked_preview(src: Path, dst: Path, source: Probe, key: bytes, material_id: str) -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("preview output must be a new file, never the original")
    if source.video_codec is None:
        raise ValueError("no video stream: the store preview is for video only")
    partial = dst.with_name(dst.name + ".partial")
    try:
        run(preview_args(src, partial, source, *offsets(key, material_id)), max(120.0, source.duration_ms / 1000 * 4), cwd=partial.parent)
        result = probe(partial)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
