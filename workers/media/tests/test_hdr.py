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


def converted_clip(path: Path, transfer: str | None) -> Path:
    """محتوى SDR محوَّل فعلًا إلى HLG أو PQ (أبيض 100 شمعة)، أو SDR كما هو حين `transfer` فارغ."""
    vf = "format=yuv420p"
    tags: list[str] = []
    if transfer:
        vf = ("zscale=tin=bt709:min=bt709:pin=bt709:t=linear:p=bt709:npl=100,format=gbrpf32le,"
              f"zscale=tin=linear:pin=bt709:min=gbr:p=bt2020:t={transfer}:m=bt2020nc:r=tv:npl=100,format=yuv420p10le")
        tags = ["-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc"]
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=640x360:rate=30:duration=1", "-vf", vf, "-c:v", "libx265", "-preset", "ultrafast",
         "-x265-params", "log-level=error:pools=none", *tags, str(path)], 120)
    return path


def _yavg(path: Path) -> float:
    out = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
               "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], 60).decode()
    values = [float(line.split("=")[1]) for line in out.splitlines() if "YAVG=" in line]
    return sum(values) / len(values)


@pytest.mark.parametrize("transfer", ["arib-std-b67", "smpte2084"], ids=["hlg", "pq"])
def test_tonemap_keeps_sdr_level_content_within_ten_percent(tmp_path: Path, transfer: str):
    # hable كان يعتم هذا المحتوى بنحو 37%؛ المشغّل المختار يبقيه في حدود 10% من مسار SDR
    sdr = make_proxy(converted_clip(tmp_path / "sdr.mp4", None), tmp_path / "sdr-proxy.mp4")
    hdr_src = converted_clip(tmp_path / "hdr.mp4", transfer)
    out = make_proxy(hdr_src, tmp_path / "hdr-proxy.mp4")
    assert probe(hdr_src).hdr and not out.hdr and not sdr.hdr
    ref, got = _yavg(tmp_path / "sdr-proxy.mp4"), _yavg(tmp_path / "hdr-proxy.mp4")
    assert abs(got - ref) <= 0.10 * ref, (got, ref)
