"""مسار الصور الثابتة: صورة JPEG أو PNG تُفحص وتُصنع لها مصغّرة معاد ترميزها بلا أي بيانات وصفية.

- قائمة بيضاء خاصة بهذا المسار وحده (أنبوبا JPEG وPNG)؛ قائمة الفيديو (`ALLOWED_DEMUXERS`) لا تتّسع بها، فلا يقرأ مسار
  الفيديو صورة، ولا يقرأ هذا المسار حاوية فيديو ولا قائمة تشغيل.
- النوع يُحسم من بايتات الملف الأولى (توقيع JPEG أو PNG) لا من الامتداد، ثم يُجبَر ffprobe وffmpeg على المفكّك المقابل (`-f`)،
  فلا تخمين للصيغة ولا مفكّك آخر، ولا بروتوكول غير الملف المحلي.
- المصغّرة JPEG معاد ترميزها: لا EXIF ولا XMP ولا ICC ولا نصوص PNG (`-map_metadata -1`، ومرمّز MJPEG لا يكتب EXIF)، فلا موقع
  ولا طراز جهاز في ما يُعرض. الأصل لا يُمس.
- اتجاه EXIF (صورة الهاتف الطولية) يُقرأ من الإطار ويُطبَّق على البكسلات بمرشّح صريح ثم يسقط الوسم؛ الدوران التلقائي في ffmpeg
  معطَّل (`-noautorotate`) لأن إصداراته تختلف في قراءته من إطار الصورة.
- HEIC وRAW (`dng`، `arw`، `nef`، `cr3`) أصول تُقبل بلا معاينة: تُعرف من بايتاتها الأولى ولا تُفكّ.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .ffmpeg import FFMPEG, FFPROBE, MediaToolError, run
from .probe import InvalidMediaError, Probe, _rotation
from .thumbnails import Thumbnail, _dims

STILL_DEMUXERS = {"jpeg": "jpeg_pipe", "png": "png_pipe"}
STILL_SHORT_SIDE = 720
# فوق هذا العدد من البكسلات لا تُفكّ الصورة (قنبلة فك ضغط)؛ يبقى الأصل متحققًا بلا مصغّرة. أكبر حسّاسات الكاميرات دونه.
MAX_PIXELS = 160_000_000
HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"}


def _guard(kind: str) -> list[str]:
    demuxer = STILL_DEMUXERS[kind]
    return ["-format_whitelist", demuxer, "-protocol_whitelist", "file", "-f", demuxer]


def _head(path: Path, size: int = 16) -> bytes:
    with open(path, "rb") as f:
        return f.read(size)


def still_format(path: Path) -> str | None:
    """`jpeg` أو `png` من توقيع الملف، وإلا `None`."""
    head = _head(path)
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    return None


def opaque_still(path: Path) -> str | None:
    """صورة كاميرا لا نفكّها: `heif` أو `cr3` (ISO-BMFF بعلامتها) أو `tiff` (DNG وARW وNEF مبنية عليه)، وإلا `None`."""
    head = _head(path)
    if head[4:8] == b"ftyp":
        if head[8:12] in HEIF_BRANDS:
            return "heif"
        if head[8:12] == b"crx ":
            return "cr3"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    return None


def _still(container: str, codec: str | None, width: int | None, height: int | None, rotation: int = 0) -> Probe:
    return Probe(
        duration_ms=0, start_pts_us=0, container=container, video_codec=codec, audio_codec=None, width=width,
        height=height, frame_rate=None, avg_frame_rate=None, vfr=False, frame_count=1 if codec else None,
        max_frame_gap_ms=None, has_gaps=False, rotation=rotation, hdr=False, bit_depth=None, audio_sample_rate=None,
        audio_channels=None,
    )


def opaque_probe(container: str) -> Probe:
    """البيانات الفنية لأصل لا يُفكّ: الحاوية وحدها، بلا أبعاد."""
    return _still(container, None, None, None)


def probe_still(path: Path, kind: str, timeout_s: float = 30) -> Probe:
    path = Path(path).resolve()
    try:
        raw = run([FFPROBE, "-v", "error", *_guard(kind), "-print_format", "json", "-show_streams", str(path)],
                  timeout_s, cwd=path.parent)
        streams = json.loads(raw).get("streams") or []
    except (MediaToolError, json.JSONDecodeError) as err:
        raise InvalidMediaError("not a readable image") from err
    image = next((s for s in streams if s.get("codec_type") == "video"), None)
    try:
        width, height = int(image["width"]), int(image["height"])
    except (TypeError, KeyError, ValueError):
        raise InvalidMediaError("image has no dimensions") from None
    if width < 1 or height < 1 or width > 100_000 or height > 100_000:
        raise InvalidMediaError("image dimensions out of range")
    return _still(kind, image.get("codec_name"), width, height, _orientation(path, kind, width * height, timeout_s))


def _orientation(path: Path, kind: str, pixels: int, timeout_s: float) -> int:
    """دوران العرض من وسم الاتجاه في JPEG (0 أو 90 أو 180 أو 270 كما في `Probe.rotation`). يفكّ الإطار، فلا يُسأل لصورة فوق الحد."""
    if kind != "jpeg" or pixels > MAX_PIXELS:
        return 0
    try:
        raw = run([FFPROBE, "-v", "error", *_guard(kind), "-print_format", "json", "-show_frames",
                   "-show_entries", "frame=side_data_list", str(path)], timeout_s, cwd=path.parent)
        frames = json.loads(raw).get("frames") or []
    except (MediaToolError, json.JSONDecodeError) as err:
        raise InvalidMediaError("image could not be decoded") from err
    return _rotation(frames[0]) if frames else 0


# `Probe.rotation` بقراءة ffprobe (270 = -90: يُدار ربع دورة مع عقارب الساعة ليُعرض قائمًا)
_TURN = {90: "transpose=cclock,", 180: "hflip,vflip,", 270: "transpose=clock,"}


def still_thumbnail(src: Path, dst: Path, kind: str, source: Probe, timeout_s: float = 60) -> Thumbnail:
    """مصغّرة JPEG بضلع قصير لا يتجاوز 720 ولا تُكبَّر، باتجاهها الصحيح وبلا أي وسم."""
    if (source.width or 0) * (source.height or 0) > MAX_PIXELS:
        raise ValueError("image too large to decode")
    w, h = _dims(source, STILL_SHORT_SIDE)
    partial = dst.with_name(dst.name + ".partial")
    try:
        run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-noautorotate", *_guard(kind),
             "-i", str(src), "-map", "0:v:0", "-map_metadata", "-1", "-map_chapters", "-1",
             "-vf", f"{_TURN.get(source.rotation, '')}scale={w}:{h}:flags=lanczos,format=yuvj420p",
             "-frames:v", "1", "-q:v", "3",
             "-f", "image2", "-c:v", "mjpeg", str(partial)], timeout_s, cwd=dst.parent)
        if not partial.exists() or partial.stat().st_size == 0:
            raise ValueError("thumbnail could not be produced")
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return Thumbnail(dst, w, h, None)
