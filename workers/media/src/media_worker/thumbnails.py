"""المصغّرات: إطار ملصق JPEG وصفيحة اتصال من 10 إطارات، ملفان جديدان بجوار النسخة الخفيفة في
`derived/<material_id>/<file_id>/` (ADR 0006).

- إطار الملصق عند الثانية 1، فإن كان أسود (تعتيم البداية، غطاء العدسة) يُجرَّب 2 ث ثم ربع المدة ثم البداية.
- صفيحة الاتصال: 10 إطارات متساوية التباعد على المدة كلها، 5×2، عرض الخانة 320.
- بلا وسوم (`-map_metadata -1`)؛ مرمّز MJPEG في ffmpeg لا يكتب EXIF، فلا إحداثيات ولا طراز جهاز.
- العامل يولّدهما من النسخة الخفيفة بعد بنائها (SDR وبلا وسوم)، فالضلع القصير للملصق ضلعها؛ وإن مُرّر مصدر HDR
  مرّ بخريطة الألوان نفسها التي تمر بها النسخة الخفيفة.
- المدخل بالتحصين نفسه (`INPUT_GUARD`)، والمخرج باسم مؤقت ثم نقل ذري.
- صور شريط الزمن للمشغّل: لوحة `sprite.jpg` (خانات 160 بكسل، 10 أعمدة، 100 خانة على الأكثر) و`thumbnails.vtt` يشير
  إلى كل خانة بـ `#xywh`، من النسخة الخفيفة لا من الأصل (فك 480p أرخص، والألوان SDR أصلًا). أزمنة الإشارات على خط
  زمن القائمة من الصفر كما يعرضه المشغّل.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run
from .probe import Probe
from .proxy import video_filter

POSTER_SHORT_SIDE = 720
SHEET_FRAMES = 10
SHEET_COLUMNS = 5
SHEET_TILE_WIDTH = 320
# متوسط الإضاءة (8 بت، مدى محدود 16–235) تحته يُعد الإطار أسود
SPRITE_TILE_WIDTH = 160
SPRITE_COLUMNS = 10
SPRITE_MAX_TILES = 100
SPRITE_MIN_INTERVAL_S = 2
BLACK_YAVG = 32.0
_YAVG = re.compile(r"lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)")


@dataclass(frozen=True)
class Thumbnail:
    path: Path
    width: int
    height: int
    at_s: float | None  # زمن الإطار من بداية الملف (للملصق)


def _jpeg(src: Path, dst: Path, vf: str, seek_s: float | None, timeout_s: float) -> float | None:
    """يكتب إطارًا واحدًا JPEG ويعيد متوسط إضاءته."""
    partial = dst.with_name(dst.name + ".partial")
    args = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    if seek_s is not None:
        args += ["-ss", f"{seek_s:.3f}"]
    args += [*INPUT_GUARD, "-i", str(src), "-map", "0:v:0", "-map_metadata", "-1", "-map_chapters", "-1",
             "-vf", f"{vf},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
             "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", str(partial)]
    try:
        out = run(args, timeout_s, cwd=dst.parent).decode()
        if not partial.exists() or partial.stat().st_size == 0:
            return None
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    m = _YAVG.search(out)
    return float(m.group(1)) if m else None


def _dims(source: Probe, short_side: int) -> tuple[int, int]:
    w, h = source.width or short_side, source.height or short_side
    if source.rotation in (90, 270):
        w, h = h, w
    short = min(short_side, w, h)
    short -= short % 2
    if w > h:
        return round(w * short / h / 2) * 2, short
    return short, round(h * short / w / 2) * 2


def poster(src: Path, dst: Path, source: Probe) -> Thumbnail:
    if source.video_codec is None:
        raise ValueError("no video stream")
    duration = source.duration_ms / 1000
    candidates = [t for t in (1.0, 2.0, duration * 0.25) if t < duration] + [0.0]
    vf = video_filter(source, POSTER_SHORT_SIDE)
    chosen = None
    for t in candidates:
        yavg = _jpeg(src, dst, vf, t, timeout_s=60)
        if yavg is None:
            continue
        chosen = t
        if yavg >= BLACK_YAVG:
            break
    if chosen is None:
        raise ValueError("no frame could be extracted")
    # إن كانت كل المرشحات سوداء يبقى آخرها (البداية) على القرص، وهو الأصدق لمقطع أسود
    w, h = _dims(source, POSTER_SHORT_SIDE)
    return Thumbnail(dst, w, h, chosen)


def contact_sheet(src: Path, dst: Path, source: Probe) -> Thumbnail:
    if source.video_codec is None:
        raise ValueError("no video stream")
    duration = max(source.duration_ms / 1000, 0.001)
    tile_w = SHEET_TILE_WIDTH
    tw, th = _dims(source, 10_000)
    tile_h = round(tile_w * th / tw / 2) * 2
    rows = (SHEET_FRAMES + SHEET_COLUMNS - 1) // SHEET_COLUMNS
    # إطار عند منتصف كل عُشر من المدة: لا إطار البداية (غالبًا أسود) ولا ما بعد النهاية
    vf = (f"fps=fps={SHEET_FRAMES}/{duration:.6f}:start_time={duration / SHEET_FRAMES / 2:.6f},"
          f"{video_filter(source, 10_000)},scale={tile_w}:{tile_h},tile={SHEET_COLUMNS}x{rows}")
    if _jpeg(src, dst, vf, None, timeout_s=max(60.0, duration * 2)) is None:
        raise ValueError("contact sheet could not be produced")
    return Thumbnail(dst, tile_w * SHEET_COLUMNS, tile_h * rows, None)


def _vtt_time(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def timeline_sprite(proxy: Path, out_dir: Path, source: Probe) -> list[Path]:
    """يعيد `[thumbnails.vtt, sprite.jpg]` في `out_dir`."""
    if source.video_codec is None:
        raise ValueError("no video stream")
    duration = max(source.duration_ms / 1000, 0.001)
    interval = max(SPRITE_MIN_INTERVAL_S, math.ceil(duration / SPRITE_MAX_TILES))
    count = max(1, math.ceil(duration / interval))
    rows = math.ceil(count / SPRITE_COLUMNS)
    tw, th = _dims(source, 10_000)
    tile_w = SPRITE_TILE_WIDTH
    tile_h = round(tile_w * th / tw / 2) * 2
    out_dir.mkdir(parents=True, exist_ok=True)
    sprite = out_dir / "sprite.jpg"
    # إطار كل `interval` ثانية من أول إطار، أيًّا كانت بداية الطوابع (-copyts)
    vf = (f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{interval})',"
          f"scale={tile_w}:{tile_h},setsar=1,tile={SPRITE_COLUMNS}x{rows}")
    if _jpeg(proxy, sprite, vf, None, timeout_s=max(60.0, duration)) is None:
        raise ValueError("timeline sprite could not be produced")
    lines = ["WEBVTT", ""]
    for i in range(count):
        x, y = (i % SPRITE_COLUMNS) * tile_w, (i // SPRITE_COLUMNS) * tile_h
        lines += [f"{_vtt_time(i * interval)} --> {_vtt_time(min((i + 1) * interval, duration))}",
                  f"sprite.jpg#xywh={x},{y},{tile_w},{tile_h}", ""]
    vtt = out_dir / "thumbnails.vtt"
    vtt.write_text("\n".join(lines), encoding="utf-8")
    return [vtt, sprite]
