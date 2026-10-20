"""مشتق HLS من النسخة الخفيفة: إعادة تغليف بلا إعادة ترميز (fMP4، مقاطع ~4 ث، قائمة تشغيل VOD واحدة).

النسخة الخفيفة فيها إطار مفتاحي كل ثانية، فتنقسم المقاطع على حدود 4 ث دون ترميز جديد. `-copyts` يحفظ طوابع
الأصل (ومنها start_pts). خلف `MEDIA_ENABLE_HLS` إلى أن يُدمج نوع `hls` في العقد (#58).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .ffmpeg import FFMPEG, INPUT_GUARD, run

SEGMENT_S = 4
PLAYLIST = "index.m3u8"


def make_hls(proxy: Path, out_dir: Path, duration_ms: int) -> list[Path]:
    """يكتب القائمة والمقاطع في مجلد جديد ويعيد ملفاته (القائمة أولًا)."""
    partial = out_dir.with_name(out_dir.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    try:
        run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
             *INPUT_GUARD, "-copyts", "-i", str(proxy), "-map", "0", "-c", "copy", "-map_metadata", "-1",
             "-f", "hls", "-hls_time", str(SEGMENT_S), "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
             "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "seg_%05d.m4s", PLAYLIST],
            timeout_s=max(120.0, duration_ms / 1000), cwd=partial)
        shutil.rmtree(out_dir, ignore_errors=True)
        partial.rename(out_dir)
    finally:
        shutil.rmtree(partial, ignore_errors=True)
    files = sorted(p for p in out_dir.iterdir() if p.name != PLAYLIST)
    return [out_dir / PLAYLIST, *files]


def playlist_duration_s(playlist: Path) -> float:
    return sum(float(line.split(":", 1)[1].split(",")[0])
               for line in playlist.read_text().splitlines() if line.startswith("#EXTINF:"))
