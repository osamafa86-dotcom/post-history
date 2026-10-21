"""صور شريط الزمن: الإشارات تغطي المدة بلا فجوة، وكل خانة داخل اللوحة، واللوحة بلا وسوم."""

import re
from pathlib import Path

from conftest import LEAKY_TAGS, synth
from media_worker.proxy import make_proxy
from media_worker.thumbnails import SPRITE_TILE_WIDTH, timeline_sprite

CUE = re.compile(r"(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\nsprite\.jpg#xywh=(\d+),(\d+),(\d+),(\d+)")


def _s(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def test_cues_cover_the_duration_and_point_inside_the_sprite(tmp_path: Path):
    src = synth(tmp_path / "s.mov", seconds=9, size="1280x720", start_offset=3, leaky_tags=True)
    proxy = make_proxy(src, tmp_path / "p.mp4")
    vtt, sprite = timeline_sprite(tmp_path / "p.mp4", tmp_path / "timeline", proxy)
    cues = CUE.findall(vtt.read_text())
    assert len(cues) == 5  # كل ثانيتين على تسع ثوانٍ
    ends = 0.0
    for c in cues:
        start, end = _s(*c[:4]), _s(*c[4:8])
        assert abs(start - ends) < 1e-6 and end > start
        ends = end
        x, y, w, h = map(int, c[8:])
        assert w == SPRITE_TILE_WIDTH and x + w <= 1600 and h == 90
    assert abs(ends - proxy.duration_ms / 1000) < 0.05
    data = sprite.read_bytes()
    assert data[:3] == b"\xff\xd8\xff" and b"Exif" not in data
    for value in LEAKY_TAGS.values():
        assert value.encode() not in data
