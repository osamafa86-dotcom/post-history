"""النسخة الخفيفة 480p من الأصل حين لا يرسل الهاتف نسخة.

- ملف جديد دائمًا؛ الأصل يُفتح للقراءة فقط عبر ffmpeg، والمخرج يُكتب باسم مؤقت ثم يُنقل ذريًا، فإعادة
  التشغيل بعد انقطاع لا تترك ملفًا ناقصًا بالاسم النهائي.
- التوقيت: `-copyts` و`-fps_mode passthrough` يحفظان طابع كل إطار كما هو في الأصل (ومنه `start_pts`)،
  فلا تُكرر إطارات ولا تُسقط في الملفات متغيرة المعدل، ونقطة القص على النسخة الخفيفة تقع على الإطار نفسه في الأصل.
- إطار مفتاحي كل ثانية للتنقل في المحرر.
- لا وسوم: `-map_metadata -1` يسقط الإحداثيات وطراز الجهاز ورقمه من النسخة المعروضة.
- HDR يُخفَّض إلى 8 بت هنا دون خريطة ألوان؛ التحويل إلى SDR بخريطة مناسبة خطوة لاحقة (البند 4 في CLAUDE.md).
"""

from __future__ import annotations

import os
from pathlib import Path

from .ffmpeg import FFMPEG, run
from .probe import Probe, probe

PROXY_SHORT_SIDE = 480
# انحراف start_pts المسموح بين الأصل والنسخة: أقل من إطار عند 60 إطارًا/ث
START_PTS_TOLERANCE_US = 16_000


class ProxyTimingError(RuntimeError):
    """النسخة الناتجة لا تحفظ start_pts الأصل؛ لا تُستخدم لأن نقاط القص عليها ستنزاح."""


def proxy_args(src: Path, dst: Path, source: Probe) -> list[str]:
    short = min(PROXY_SHORT_SIDE, min(source.width or PROXY_SHORT_SIDE, source.height or PROXY_SHORT_SIDE))
    short -= short % 2
    # ffmpeg يطبّق الدوران قبل المرشحات، فـ iw/ih هنا أبعاد العرض الفعلية
    scale = f"scale='if(gt(iw,ih),-2,{short})':'if(gt(iw,ih),{short},-2)',format=yuv420p"
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-copyts", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-vf", scale, "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-profile:v", "high",
        "-force_key_frames", "expr:gte(t,n_forced*1)",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        "-movflags", "+faststart",
        "-f", "mp4", str(dst),
    ]


def make_proxy(src: Path, dst: Path, source: Probe | None = None) -> Probe:
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise ValueError("proxy output must be a new file, never the original")
    source = source or probe(src)
    if source.video_codec is None:
        raise ValueError("no video stream: proxy is for video files only")

    partial = dst.with_name(dst.name + ".partial")
    timeout = max(120.0, source.duration_ms / 1000 * 4)
    try:
        run(proxy_args(src, partial, source), timeout)
        result = probe(partial)
        if abs(result.start_pts_us - source.start_pts_us) > START_PTS_TOLERANCE_US:
            raise ProxyTimingError(
                f"proxy start_pts {result.start_pts_us}us != source {source.start_pts_us}us"
            )
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
