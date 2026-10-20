import json
from pathlib import Path

from conftest import synth
from media_worker.ffmpeg import FFMPEG, run
from media_worker.hls import make_hls, playlist_duration_s
from media_worker.phash import matches, video_phash
from media_worker.probe import probe
from media_worker.proxy import make_proxy
from media_worker.waveform import write_waveform


def test_hls_from_proxy_keeps_duration(tmp_path: Path):
    src = synth(tmp_path / "src.mp4", seconds=10, size="1280x720", start_offset=2)
    info = make_proxy(src, tmp_path / "proxy.mp4")
    files = make_hls(tmp_path / "proxy.mp4", tmp_path / "hls", info.duration_ms)
    assert files[0].name == "index.m3u8" and (tmp_path / "hls" / "init.mp4") in files
    segs = [f for f in files if f.suffix == ".m4s"]
    assert 2 <= len(segs) <= 4
    # القائمة تجمع مقاطع الفيديو؛ مدة الحاوية تشمل حواف AAC، فالمقارنة بمدة الفيديو الاسمية (10 ث، 300 إطار)
    assert abs(playlist_duration_s(files[0]) - 10.0) <= 0.04


def test_waveform_100_points_per_minute_without_tags(tmp_path: Path):
    src = synth(tmp_path / "src.mov", seconds=90, size="320x240", leaky_tags=True)
    data = json.loads(write_waveform(src, tmp_path / "w.json", probe(src).duration_ms).read_text())
    assert set(data) == {"version", "points_per_minute", "duration_ms", "peaks"}
    assert 149 <= len(data["peaks"]) <= 151 and 0.1 < max(data["peaks"]) <= 1.0  # sine في lavfi بسعة 1/8


def test_phash_matches_reencode_and_rejects_other_clip(tmp_path: Path):
    src = synth(tmp_path / "a.mp4", seconds=12, size="1280x720")
    re_encoded = tmp_path / "a-small.mp4"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vf", "scale=640:360",
         "-c:v", "libx264", "-crf", "35", "-an", str(re_encoded)], 60)
    other = tmp_path / "b.mp4"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "mandelbrot=size=1280x720:rate=30", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", str(other)], 120)
    a, b, c = video_phash(src), video_phash(re_encoded), video_phash(other)
    assert len(a) == 6 and matches(a, b) and not matches(a, c)
