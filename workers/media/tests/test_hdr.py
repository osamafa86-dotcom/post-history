from pathlib import Path

import pytest

from media_worker.ffmpeg import FFMPEG, FFPROBE, run
from media_worker.probe import probe
from media_worker.proxy import make_proxy
from media_worker.thumbnails import poster

# ما يقبله الخادم في technical (apps/api/src/media/media-schemas.ts): لا مفتاح جديد يتسلل من probe
SERVER_TECHNICAL_KEYS = {
    "duration_ms", "start_pts_us", "width", "height", "container", "video_codec", "audio_codec", "frame_rate",
    "avg_frame_rate", "vfr", "frame_count", "max_frame_gap_ms", "has_gaps", "rotation", "hdr", "bit_depth",
    "audio_sample_rate", "audio_channels",
}


def hdr_clip(path: Path, transfer: str, seconds: int = 3, start_offset: float = 2.0) -> Path:
    """HEVC 10 بت موسوم BT.2020 + HLG أو PQ، كما تسجّل الهواتف."""
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}",
         "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast",
         "-x265-params", f"log-level=error:pools=none:colorprim=bt2020:transfer={transfer}:colormatrix=bt2020nc",
         "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc", "-tag:v", "hvc1",
         "-c:a", "aac", "-output_ts_offset", str(start_offset), str(path)], 120)
    return path


def _color(path: Path) -> str:
    return run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=pix_fmt,color_transfer,color_primaries", "-of", "csv=p=0", str(path)], 30).decode().strip()


@pytest.mark.parametrize("transfer", ["arib-std-b67", "smpte2084"], ids=["hlg", "pq"])
def test_hdr_is_detected_and_tonemapped_to_sdr(tmp_path: Path, transfer: str):
    src = hdr_clip(tmp_path / "hdr.mp4", transfer)
    info = probe(src)
    assert info.hdr and info.color_transfer == transfer and info.bit_depth in (10, None)
    assert set(info.to_dict()) <= SERVER_TECHNICAL_KEYS

    out = make_proxy(src, tmp_path / "proxy.mp4", info)
    assert not out.hdr and out.start_pts_us == info.start_pts_us == 2_000_000
    assert _color(tmp_path / "proxy.mp4") == "yuv420p,bt709,bt709"

    t = poster(src, tmp_path / "poster.jpg", info)
    assert t.path.stat().st_size > 0


def test_sdr_keeps_its_untagged_path(tmp_path: Path):
    from conftest import synth

    src = synth(tmp_path / "sdr.mp4", seconds=2)
    info = probe(src)
    assert not info.hdr
    assert set(info.to_dict()) <= SERVER_TECHNICAL_KEYS
