"""النسخة الخفيفة 480p من الأصل حين لا يرسل الهاتف نسخة.

- ملف جديد دائمًا؛ الأصل يُفتح للقراءة فقط عبر ffmpeg، والمخرج يُكتب باسم مؤقت ثم يُنقل ذريًا، فإعادة
  التشغيل بعد انقطاع لا تترك ملفًا ناقصًا بالاسم النهائي.
- التوقيت: `-copyts` و`-fps_mode passthrough` يحفظان طابع كل إطار كما هو في الأصل (ومنه `start_pts`)،
  فلا تُكرر إطارات ولا تُسقط في الملفات متغيرة المعدل، ونقطة القص على النسخة الخفيفة تقع على الإطار نفسه في الأصل.
- إطار مفتاحي كل ثانية للتنقل في المحرر.
- لا وسوم: `-map_metadata -1` ومثيلاه لكل مسار تسقط الإحداثيات وطراز الجهاز ورقمه من النسخة المعروضة.
- المدخل مقيد بقائمة الحاويات والبروتوكول `file` وحده (`INPUT_GUARD`).
- HDR (HLG أو PQ): خريطة ألوان إلى SDR BT.709 بـ zscale + tonemap (hable)، فلا تظهر النسخة باهتة أو محروقة؛
  والمخرج موسوم bt709 صراحة. القياس في `tools/render-bench` (حالتا HLG وPQ).
"""

from __future__ import annotations

import os
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe, probe

PROXY_SHORT_SIDE = 480
# انحراف start_pts المسموح بين الأصل والنسخة: أقل من إطار عند 60 إطارًا/ث
START_PTS_TOLERANCE_US = 16_000


class ProxyTimingError(RuntimeError):
    """النسخة الناتجة لا تحفظ start_pts الأصل؛ لا تُستخدم لأن نقاط القص عليها ستنزاح."""


def video_filter(source: Probe, short_side: int) -> str:
    """تصغير بالضلع القصير (بلا تكبير) ثم خريطة ألوان إلى SDR إن كان المصدر HDR، وأخيرًا 8 بت 4:2:0.
    يُستعمل للنسخة الخفيفة وللمصغّرات معًا."""
    short = min(short_side, min(source.width or short_side, source.height or short_side))
    short -= short % 2
    # ffmpeg يطبّق الدوران قبل المرشحات، فـ iw/ih هنا أبعاد العرض الفعلية
    chain = [f"scale='if(gt(iw,ih),-2,{short})':'if(gt(iw,ih),{short},-2)'"]
    if source.hdr:
        # التصغير أولًا: الخريطة بأعداد عشرية على 480p أرخص بكثير منها على 4K
        tin = source.color_transfer
        pin = source.color_primaries if source.color_primaries not in (None, "unknown") else "bt2020"
        min_ = source.color_space if source.color_space not in (None, "unknown") else "bt2020nc"
        chain += [
            f"zscale=tin={tin}:pin={pin}:min={min_}:t=linear:npl=100",
            "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0",
            "zscale=t=bt709:m=bt709:r=tv",
        ]
    chain.append("format=yuv420p")
    return ",".join(chain)


SDR_TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]


def proxy_args(src: Path, dst: Path, source: Probe) -> list[str]:
    scale = video_filter(source, PROXY_SHORT_SIDE)
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        *INPUT_GUARD, "-copyts", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        # الوسوم العامة ووسوم كل مسار (قد يحمل المسار نفسه موقعًا أو طراز الجهاز)
        "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
        "-vf", scale, "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-profile:v", "high",
        "-force_key_frames", "expr:gte(t,n_forced*1)",
        *(SDR_TAGS if source.hdr else []),
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
        run(proxy_args(src, partial, source), timeout, cwd=partial.parent)
        result = probe(partial)
        if abs(result.start_pts_us - source.start_pts_us) > START_PTS_TOLERANCE_US:
            raise ProxyTimingError(
                f"proxy start_pts {result.start_pts_us}us != source {source.start_pts_us}us"
            )
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return result
