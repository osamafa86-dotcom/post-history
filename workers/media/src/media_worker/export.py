"""حزمة التصدير إلى برامج المونتاج (DaVinci Resolve وPremiere وFinal Cut).

أرشيف ZIP فيه:
- `clip.<ext>`: ملف جديد من الأصل بنسخ التيارات بلا إعادة ترميز (الجودة الكاملة نفسها)، منزوع البيانات الوصفية:
  وسوم الحاوية والتيارات والفصول، ولا يُنقل إلا أول مسار فيديو وأول مسار صوت، فتسقط مسارات البيانات والترجمة التي
  قد تحمل موقعًا أو طراز الجهاز. الأصل المخزَّن لا يُمس ولا يدخل الحزمة.
- `proxy.mp4`: النسخة الخفيفة إن وُجدت عند العامل (منزوعة الوسوم أصلًا).
- `metadata.json`: ملف جانبي بقائمة بيضاء مغلقة (معرّفات وبصمة الأصل المخزَّن وبيانات `Probe.to_dict()` الفنية).
  لا إحداثيات ولا طراز جهاز ولا اسم مصدر: العامل لا يملكها أصلًا، و`Probe` لا ينقل الوسوم.
- `sequence.fcpxml` و`sequence.edl`: تسلسل بلقطة واحدة تغطي المقطع كله، يُربط بـ `clip.<ext>` بمسار نسبي.
- `SHA256SUMS`: بصمة كل ملف بصيغة `sha256sum -c`.

الأرشيف حتمي (توقيت ثابت وترتيب ثابت)، فإعادة التسليم تنتج البصمة نفسها.
"""

from __future__ import annotations

import hashlib
import json
import os
import zipfile
from fractions import Fraction
from pathlib import Path
from xml.sax.saxutils import quoteattr

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .hashing import digest_file
from .isobmff import strip_hvcc_sei
from .probe import Probe, probe

EXTENSIONS = {"mov": "mov", "matroska": "mkv", "mpegts": "ts"}
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
CHUNK = 1 << 20
SIDECAR_SCHEMA = "post-history/export-sidecar@1"


def frame_rate(info: Probe) -> Fraction:
    """المعدل الاسمي كنسبة: 29.97 ← 30000/1001، وإلا أقرب عدد صحيح."""
    fps = info.frame_rate or info.avg_frame_rate or 25.0
    whole = round(fps)
    if abs(fps - whole * 1000 / 1001) < 0.005:
        return Fraction(whole * 1000, 1001)
    return Fraction(whole)


def frame_count(info: Probe, rate: Fraction) -> int:
    return max(1, round(Fraction(info.duration_ms, 1000) * rate))


def _rational(frames: int, rate: Fraction) -> str:
    t = frames / rate
    return f"{t.numerator}/{t.denominator}s" if t.denominator != 1 else f"{t.numerator}s"


def fcpxml(info: Probe, media_name: str, title: str) -> str:
    """FCPXML 1.9 (‏`media-rep`): يقبله Final Cut 10.4.6+ وResolve 17+ وPremiere عبر الاستيراد."""
    rate = frame_rate(info)
    frames = frame_count(info, rate)
    dur = _rational(frames, rate)
    fd = 1 / rate
    audio = info.audio_codec is not None
    asset_audio = (f' hasAudio="1" audioSources="1" audioChannels="{info.audio_channels or 2}"'
                   f' audioRate="{info.audio_sample_rate or 48000}"' if audio else ' hasAudio="0"')
    name = quoteattr(title)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="{fd.numerator}/{fd.denominator}s" width="{info.width}" height="{info.height}"/>
    <asset id="r2" name={name} start="0s" duration="{dur}" hasVideo="1" format="r1"{asset_audio}>
      <media-rep kind="original-media" src={quoteattr(media_name)}/>
    </asset>
  </resources>
  <library>
    <event name={name}>
      <project name={name}>
        <sequence format="r1" duration="{dur}" tcStart="0s" tcFormat="NDF"{' audioLayout="stereo" audioRate="48k"' if audio else ''}>
          <spine>
            <asset-clip ref="r2" name={name} offset="0s" start="0s" duration="{dur}" tcFormat="NDF"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""


def _timecode(frames: int, base: int) -> str:
    s, f = divmod(frames, base)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def edl(info: Probe, media_name: str, title: str) -> str:
    """CMX3600 بحدث واحد، توقيت NDF بأساس المعدل المقرَّب، والتسجيل يبدأ عند 01:00:00:00 كالعادة."""
    base = round(frame_rate(info))
    frames = frame_count(info, frame_rate(info))
    rec0 = 3600 * base
    track = "AA/V" if info.audio_codec else "V"
    return (f"TITLE: {title}\nFCM: NON-DROP FRAME\n\n"
            f"001  ORIGINAL {track:<5} C        {_timecode(0, base)} {_timecode(frames, base)} "
            f"{_timecode(rec0, base)} {_timecode(rec0 + frames, base)}\n"
            f"* FROM CLIP NAME: {media_name}\n")


# رسائل البيانات داخل تيار الفيديو نفسه (لا في الحاوية) تحمل نصًا حرًّا قد يكون معرّف جهاز أو اسم برنامج: SEI في
# H.264 (6) وHEVC (39 و40، ومنها user_data_unregistered)، وOBU البيانات في AV1 (5). تُحذف وحدات NAL كلها في نسخ
# التيارات. HDR يبقى: دالة النقل والألوان في VUI لمجموعة المعاملات، وبيانات العرض الثابتة في صندوقي mdcv/clli
# للحاوية إن حملها الأصل.
IN_BAND_METADATA = {"h264": "filter_units=remove_types=6", "hevc": "filter_units=remove_types=39|40",
                    "av1": "filter_units=remove_types=5"}


def strip_metadata(src: Path, dst: Path, timeout_s: float = 1800, video_codec: str | None = None) -> None:
    """نسخ التيارات بلا ترميز إلى ملف جديد بلا أي بيانات وصفية، في الحاوية ولا داخل تيار الفيديو. `-copyts` يحفظ
    `start_pts`، و`bitexact` يجعل الناتج حتميًا ولا يكتب توقيت الإنشاء ولا اسم المُرمِّز. مرمّز لا نعرف كيف تُنزع
    بياناته المضمّنة يُرفض بدل أن يُنسخ كما هو."""
    if Path(src).resolve() == Path(dst).resolve():
        raise ValueError("export output must be a new file, never the original")
    codec = video_codec or probe(src).video_codec
    if codec not in IN_BAND_METADATA:
        raise ValueError(f"no in-band metadata filter for video codec {codec!r}")
    if codec == "hevc" and Path(dst).suffix != ".mov":
        raise ValueError("HEVC is exported to .mov so its hvcC can be cleaned")
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         *INPUT_GUARD, "-copyts", "-i", str(src),
         "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-bsf:v", IN_BAND_METADATA[codec],
         "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
         "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
         str(dst)], timeout_s=timeout_s, cwd=Path(dst).parent)
    if codec == "hevc":
        strip_hvcc_sei(Path(dst))


def sidecar(material_id: str, file_id: str, media_name: str, sha256: str, size_bytes: int, info: Probe) -> dict:
    # بصمة الأصل المخزَّن وحجمه للربط به في المكتبة؛ بصمة `clip` نفسها في SHA256SUMS
    return {"schema": SIDECAR_SCHEMA, "material_id": material_id, "file_id": file_id,
            "media": media_name, "original": {"sha256": sha256, "size_bytes": size_bytes},
            "technical": info.to_dict()}


def _add(zf: zipfile.ZipFile, name: str, src: Path | bytes, sums: dict[str, str], stored: bool) -> None:
    zi = zipfile.ZipInfo(name, ZIP_TIME)
    zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    zi.external_attr = 0o644 << 16
    h = hashlib.sha256()
    if isinstance(src, bytes):
        h.update(src)
        zf.writestr(zi, src)
    else:
        with open(src, "rb") as fh, zf.open(zi, "w", force_zip64=True) as out:
            while chunk := fh.read(CHUNK):
                h.update(chunk)
                out.write(chunk)
    sums[name] = h.hexdigest()


def build_package(out: Path, *, original: Path, info: Probe, material_id: str, file_id: str,
                  sha256: str, size_bytes: int, proxy: Path | None) -> dict[str, str]:
    """يكتب الأرشيف ذريًا ويعيد بصمة كل ملف فيه. الأصل يُقرأ فقط ولا يدخل الأرشيف."""
    if not info.video_codec or not info.width or not info.height:
        raise ValueError("export needs a video original")
    if digest_file(original).sha256 != sha256:
        raise ValueError("original changed since verification")
    # HEVC في mov دائمًا: ترويس hvcC فيه يُنقّى من SEI، وCodecPrivate في mkv لا يُعاد بناؤه
    media_name = "clip.mov" if info.video_codec == "hevc" else f"clip.{EXTENSIONS.get(info.container, 'mov')}"
    clip = out.with_name(media_name)
    strip_metadata(original, clip, video_codec=info.video_codec)
    title = file_id
    sums: dict[str, str] = {}
    partial = out.with_name(out.name + ".partial")
    with zipfile.ZipFile(partial, "w") as zf:
        _add(zf, media_name, clip, sums, stored=True)
        if proxy is not None:
            _add(zf, "proxy.mp4", proxy, sums, stored=True)
        meta = sidecar(material_id, file_id, media_name, sha256, size_bytes, info)
        _add(zf, "metadata.json", json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True).encode(),
             sums, stored=False)
        _add(zf, "sequence.fcpxml", fcpxml(info, media_name, title).encode(), sums, stored=False)
        _add(zf, "sequence.edl", edl(info, media_name, title).encode(), sums, stored=False)
        manifest = "".join(f"{h}  {n}\n" for n, h in sums.items()).encode()
        _add(zf, "SHA256SUMS", manifest, {}, stored=False)
    os.replace(partial, out)
    clip.unlink()
    return sums

