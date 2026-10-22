"""حزمة تسليم المشتري: البنود المطلوبة وحدها، بلا بيانات كاشفة في أي ملف، والأصل لا يُمس ولا يدخل كما هو."""

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from media_worker.delivery import build_delivery
from media_worker.ffmpeg import FFMPEG, FFPROBE, run
from media_worker.probe import probe

LIC = "11000000-0000-4000-8000-000000000001"


def _packets(path: Path) -> bytes:
    """إطارات مفكوكة (حذف SEI يغيّر الحزم لا الصورة) وحزم الصوت كما هي."""
    out = b""
    for args in (["-map", "0:v:0"], ["-map", "0:a:0", "-c", "copy"]):
        out += run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), *args,
                    "-f", "framemd5", "-"], timeout_s=60)
    return b"".join(line for line in out.splitlines(True) if not line.startswith(b"#"))


@pytest.fixture(scope="module")
def src(tmp_path_factory) -> Path:
    return synth(tmp_path_factory.mktemp("dl") / "src.mov", seconds=3, size="1280x720", start_offset=2,
                 leaky_tags=True, stream_tags=True)


def test_all_original_based_deliverables_without_revealing_data(src: Path, tmp_path: Path):
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    out = tmp_path / "delivery.zip"
    m = build_delivery(out, original=src, info=probe(src), license_id=LIC, sha256=sha,
                       deliverables=["original", "audio", "stills", "produced"])
    assert m["deliverables"]["produced"] == "not_available" and set(m) == {"schema", "license_id", "deliverables"}
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        assert names[:2] == ["original.mov", "audio.wav"] and len([n for n in names if n.startswith("stills/")]) == 5
        for name in names:
            data = zf.read(name)
            for value in [*LEAKY_TAGS.values(), "x264 - core"]:  # والنص الحر في SEI داخل التيار
                assert value.encode() not in data, (name, value)
            # ولا بصمة الأصل الخام في أي ملف، manifest.json منها (ADR 0060)
            assert sha.encode() not in data and bytes.fromhex(sha) not in data, name
            assert b"Exif" not in data and b"LIST" not in data[:64]
        zf.extract("original.mov", tmp_path)
        zf.extract("audio.wav", tmp_path)
        zf.extract("stills/still_03.jpg", tmp_path)
        for line in zf.read("SHA256SUMS").decode().splitlines():
            h, n = line.split("  ")
            assert hashlib.sha256(zf.read(n)).hexdigest() == h
    assert _packets(tmp_path / "original.mov") == _packets(src)
    wav = probe(tmp_path / "audio.wav")
    assert (wav.audio_codec, wav.audio_sample_rate) == ("pcm_s16le", 48000)
    still = tmp_path / "stills" / "still_03.jpg"
    assert still.read_bytes()[:3] == b"\xff\xd8\xff"
    dims = run([FFPROBE, "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(still)],
               timeout_s=30).decode().strip()
    assert dims == "1280,720"  # بالدقة الكاملة لا مصغّرة
    assert hashlib.sha256(src.read_bytes()).hexdigest() == sha  # الأصل لم يُمس


def test_only_requested_items_and_passed_extras(src: Path, tmp_path: Path):
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    produced = tmp_path / "p.mp4"
    produced.write_bytes(b"produced")
    out = tmp_path / "d.zip"
    m = build_delivery(out, original=src, info=probe(src), license_id=LIC, sha256=sha,
                       deliverables=["produced"], extras={"produced": produced})
    assert m["deliverables"] == {"produced": ["produced.mp4"]}
    with zipfile.ZipFile(out) as zf:
        assert zf.namelist() == ["produced.mp4", "manifest.json", "SHA256SUMS"]
        assert json.loads(zf.read("manifest.json"))["license_id"] == LIC


def test_refuses_unknown_items_and_changed_original(src: Path, tmp_path: Path):
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    with pytest.raises(ValueError):
        build_delivery(tmp_path / "x.zip", original=src, info=probe(src), license_id=LIC, sha256=sha,
                       deliverables=["raw_with_gps"])
    with pytest.raises(ValueError):  # التفريغ خارج التسليم (R11)
        build_delivery(tmp_path / "x.zip", original=src, info=probe(src), license_id=LIC, sha256=sha,
                       deliverables=["transcript"])
    with pytest.raises(ValueError):
        build_delivery(tmp_path / "x.zip", original=src, info=probe(src), license_id=LIC, sha256="0" * 64,
                       deliverables=["original"])
    assert not (tmp_path / "x.zip").exists()
