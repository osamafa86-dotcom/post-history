"""البيانات الفنية لملف وسائط من ffprobe.

`Probe` قائمة بيضاء مغلقة: لا تُنقل الوسوم (tags) أبدًا لأنها تحمل إحداثيات GPS وطراز الجهاز ورقمه
(`location`، `com.apple.quicktime.location.ISO6709`، `make`، `model`). ما ليس حقلًا هنا لا يخرج من العامل.
"""

from __future__ import annotations

import json
import statistics
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path

from .ffmpeg import ALLOWED_DEMUXERS, FFPROBE, INPUT_GUARD, MediaToolError, run

# تذبذب مدد الإطارات تحت هذه النسبة من الوسيط يُعد تقريبًا للمؤقت لا معدلًا متغيرًا
# (29.97 بمقياس 1/600 يتأرجح بين 20 و21 نبضة = 5%)
VFR_TOLERANCE = 0.10
# فاصل أطول من هذا المضاعف للوسيط بين إطارين متتاليين = فجوة زمنية (إطارات ساقطة أو توقف تسجيل)
GAP_FACTOR = 2.5
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}


class InvalidMediaError(ValueError):
    """الملف ليس وسائط صالحة (صيغة غير معروفة، تالف، بلا مسارات، بلا مدة). يقابل `invalid_file` في العقد."""


@dataclass(frozen=True)
class Probe:
    duration_ms: int
    # بداية مسار الفيديو (أو الصوت إن لم يوجد فيديو) بالميكروثانية؛ مرجع نقاط القص في الخط الزمني
    start_pts_us: int
    container: str
    video_codec: str | None
    audio_codec: str | None
    width: int | None
    height: int | None
    # المعدل الاسمي من الحاوية، والمتوسط الفعلي من عدد الإطارات على المدة
    frame_rate: float | None
    avg_frame_rate: float | None
    vfr: bool
    frame_count: int | None
    max_frame_gap_ms: float | None
    has_gaps: bool
    rotation: int
    hdr: bool
    bit_depth: int | None
    audio_sample_rate: int | None
    audio_channels: int | None

    def to_dict(self) -> dict:
        return asdict(self)


def _rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "0/1"}:
        return None
    try:
        r = Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None
    return round(float(r), 3) if r > 0 else None


def _seconds(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "N/A") else None
    except ValueError:
        return None


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            return int(round(float(sd["rotation"]))) % 360
    return 0


def _frame_timing(path: Path, timeout_s: float) -> tuple[int, bool, float | None, bool]:
    """يقرأ توقيتات حزم الفيديو دون فك ترميزها: العدد، هل المعدل متغير، أطول فاصل، هل توجد فجوات."""
    out = run(
        [FFPROBE, "-v", "error", *INPUT_GUARD, "-select_streams", "v:0", "-show_entries", "packet=pts_time",
         "-of", "csv=p=0", str(path)],
        timeout_s, cwd=path.parent,
    )
    pts = sorted(t for line in out.decode().split() if (t := _seconds(line.strip(","))) is not None)
    if len(pts) < 3:
        return len(pts), False, None, False
    deltas = [b - a for a, b in zip(pts, pts[1:]) if b > a]
    median = statistics.median(deltas)
    spread = [d for d in deltas if abs(d - median) > median * VFR_TOLERANCE]
    gap = max(deltas)
    # إطار واحد شاذ (مثل آخر إطار) لا يجعل الملف متغير المعدل؛ 1% من الفواصل أو أكثر يجعله كذلك
    vfr = len(spread) > max(1, len(deltas) // 100)
    return len(pts), vfr, round(gap * 1000, 3), gap > median * GAP_FACTOR


def probe(path: Path, timeout_s: float = 120) -> Probe:
    path = Path(path).resolve()
    try:
        raw = run(
            [FFPROBE, "-v", "error", *INPUT_GUARD, "-print_format", "json", "-show_format", "-show_streams",
             str(path)],
            timeout_s, cwd=path.parent,
        )
        info = json.loads(raw)
    except (MediaToolError, json.JSONDecodeError) as err:
        raise InvalidMediaError("not a readable media file") from err

    streams = info.get("streams") or []
    fmt = info.get("format") or {}
    # INPUT_GUARD يمنع ما سواها في ffprobe نفسه؛ الفحص هنا يثبت ذلك صراحة قبل أي معالجة لاحقة
    if not set((fmt.get("format_name") or "").split(",")) & set(ALLOWED_DEMUXERS):
        raise InvalidMediaError("container format not allowed")
    # صور الغلاف المضمّنة مسار فيديو بإطار واحد؛ لا تُحسب فيديو
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise InvalidMediaError("no audio or video stream")

    duration = _seconds(fmt.get("duration")) or _seconds((video or audio).get("duration"))
    if not duration or duration <= 0:
        raise InvalidMediaError("no duration")
    ref = video or audio
    start = _seconds(ref.get("start_time"))
    if start is None:
        start = _seconds(fmt.get("start_time")) or 0.0

    frame_count = gap_ms = None
    vfr = has_gaps = False
    if video is not None:
        frame_count, vfr, gap_ms, has_gaps = _frame_timing(path, timeout_s)
        if frame_count == 0:
            raise InvalidMediaError("video stream has no frames")

    bit_depth = None
    if video is not None and video.get("bits_per_raw_sample"):
        try:
            bit_depth = int(video["bits_per_raw_sample"])
        except ValueError:
            bit_depth = None

    return Probe(
        duration_ms=round(duration * 1000),
        start_pts_us=round(start * 1_000_000),
        container=(fmt.get("format_name") or "").split(",")[0],
        video_codec=video.get("codec_name") if video else None,
        audio_codec=audio.get("codec_name") if audio else None,
        width=int(video["width"]) if video and video.get("width") else None,
        height=int(video["height"]) if video and video.get("height") else None,
        frame_rate=_rate(video.get("r_frame_rate")) if video else None,
        avg_frame_rate=_rate(video.get("avg_frame_rate")) if video else None,
        vfr=vfr,
        frame_count=frame_count,
        max_frame_gap_ms=gap_ms,
        has_gaps=has_gaps,
        rotation=_rotation(video) if video else 0,
        hdr=bool(video) and video.get("color_transfer") in HDR_TRANSFERS,
        bit_depth=bit_depth,
        audio_sample_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        audio_channels=int(audio["channels"]) if audio and audio.get("channels") else None,
    )
