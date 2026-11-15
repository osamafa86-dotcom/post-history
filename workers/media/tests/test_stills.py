"""مسار الصور الثابتة: فحص JPEG وPNG بقائمة بيضاء خاصة، ومصغّرة معاد ترميزها بلا أي بيانات وصفية."""

import struct
import zlib
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from media_worker.ffmpeg import ALLOWED_DEMUXERS, FFMPEG, FFPROBE, run
from media_worker.probe import InvalidMediaError, probe
from media_worker.stills import STILL_SHORT_SIDE, opaque_still, probe_still, still_format, still_thumbnail

# القيم الاصطناعية نفسها التي تُزرع في الفيديو (conftest): غير واقعية عمدًا
MAKER = LEAKY_TAGS["com.apple.quicktime.make"].encode()
MODEL = LEAKY_TAGS["com.apple.quicktime.model"].encode()
PLACE = LEAKY_TAGS["com.apple.quicktime.location.ISO6709"].encode()


def _image(path: Path, size: str = "1280x720") -> Path:
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"testsrc2=size={size}:rate=1:duration=1", "-frames:v", "1", str(path)], timeout_s=60)
    return path


def _exif(orientation: int) -> bytes:
    """مقطع APP1 بثلاثة وسوم: الصانع والطراز والاتجاه، ومعها IFD لإحداثيات GPS."""
    def entry(tag: int, kind: int, count: int, value: bytes) -> bytes:
        return struct.pack("<HHI", tag, kind, count) + value.ljust(4, b"\0")[:4]

    make, model = MAKER + b"\0", MODEL + b"\0"
    ifd0_at, entries = 8, 4
    data_at = ifd0_at + 2 + entries * 12 + 4
    gps_at = data_at + len(make) + len(model)
    lat_at = gps_at + 2 + 2 * 12 + 4
    ifd0 = struct.pack("<H", entries) + b"".join([
        entry(0x010F, 2, len(make), struct.pack("<I", data_at)),
        entry(0x0110, 2, len(model), struct.pack("<I", data_at + len(make))),
        entry(0x0112, 3, 1, struct.pack("<H", orientation)),
        entry(0x8825, 4, 1, struct.pack("<I", gps_at)),
    ]) + struct.pack("<I", 0)
    gps = struct.pack("<H", 2) + entry(0x0001, 2, 2, b"N\0") + entry(0x0002, 5, 3, struct.pack("<I", lat_at)) \
        + struct.pack("<I", 0)
    lat = struct.pack("<6I", 31, 1, 30, 1, 0, 1)
    tiff = b"II*\0" + struct.pack("<I", ifd0_at) + ifd0 + make + model + gps + lat
    body = b"Exif\0\0" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body


def _with_exif(src: Path, dst: Path, orientation: int = 1) -> Path:
    data = src.read_bytes()
    assert data[:2] == b"\xff\xd8"
    comment = b"\xff\xfe" + struct.pack(">H", len(PLACE) + 2) + PLACE
    dst.write_bytes(data[:2] + _exif(orientation) + comment + data[2:])
    return dst


def _with_text(src: Path, dst: Path) -> Path:
    """PNG بقطعة نص (tEXt) تحمل ما لا يجوز أن يخرج."""
    data = src.read_bytes()
    body = b"Comment\0" + PLACE + b" " + MODEL
    chunk = struct.pack(">I", len(body)) + b"tEXt" + body + struct.pack(">I", zlib.crc32(b"tEXt" + body))
    dst.write_bytes(data[:33] + chunk + data[33:])  # بعد التوقيع وقطعة IHDR
    return dst


def _size(path: Path) -> tuple[int, int]:
    out = run([FFPROBE, "-v", "error", "-f", "jpeg_pipe", "-show_entries", "stream=width,height", "-of", "csv=p=0",
               str(path)], timeout_s=30).decode().strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def test_a_camera_jpeg_is_a_still_with_its_size_and_no_duration(tmp_path: Path):
    src = _image(tmp_path / "IMG_0001.JPG")
    assert still_format(src) == "jpeg"
    info = probe_still(src, "jpeg")
    assert (info.width, info.height, info.duration_ms, info.start_pts_us) == (1280, 720, 0, 0)
    assert info.container == "jpeg" and info.video_codec == "mjpeg" and info.audio_codec is None
    assert info.frame_count == 1 and info.vfr is False


def test_a_png_is_a_still(tmp_path: Path):
    src = _image(tmp_path / "shot.png", "640x800")
    assert still_format(src) == "png"
    info = probe_still(src, "png")
    assert (info.width, info.height, info.container, info.video_codec) == (640, 800, "png", "png")


def test_the_video_path_still_refuses_images_and_the_still_path_refuses_video(tmp_path: Path):
    image, clip = _image(tmp_path / "a.jpg"), synth(tmp_path / "clip.mp4", seconds=1)
    with pytest.raises(InvalidMediaError):
        probe(image)
    assert not {"image2", "jpeg_pipe", "png_pipe"} & set(ALLOWED_DEMUXERS)
    assert still_format(clip) is None
    # ملف فيديو باسم صورة لا يمرّ من مسار الصور: التوقيع من البايتات لا من الامتداد
    disguised = tmp_path / "clip.jpg"
    disguised.write_bytes(clip.read_bytes())
    assert still_format(disguised) is None


@pytest.mark.parametrize("content", [b"\xff\xd8\xff" + b"not a jpeg at all" * 50, b"\x89PNG\r\n\x1a\n" + b"\0" * 200])
def test_a_signature_alone_is_not_an_image(tmp_path: Path, content: bytes):
    src = tmp_path / "fake.bin"
    src.write_bytes(content)
    kind = still_format(src)
    assert kind in ("jpeg", "png")
    with pytest.raises(InvalidMediaError):
        probe_still(src, kind)


def test_the_thumbnail_is_re_encoded_with_no_metadata_at_all(tmp_path: Path):
    src = _with_exif(_image(tmp_path / "plain.jpg"), tmp_path / "IMG_0002.JPG")
    raw = src.read_bytes()
    assert MAKER in raw and MODEL in raw and PLACE in raw and b"Exif" in raw
    thumb = still_thumbnail(src, tmp_path / "poster.jpg", "jpeg", probe_still(src, "jpeg"))
    data = thumb.path.read_bytes()
    assert data[:3] == b"\xff\xd8\xff"
    for planted in (MAKER, MODEL, PLACE, b"Exif", b"GPS", b"ICC_PROFILE"):
        assert planted not in data
    assert (thumb.width, thumb.height) == _size(thumb.path) == (1280, STILL_SHORT_SIDE)
    assert src.read_bytes() == raw  # الأصل لا يُمس


def test_a_png_thumbnail_drops_its_text_chunks(tmp_path: Path):
    src = _with_text(_image(tmp_path / "plain.png", "400x300"), tmp_path / "shot.png")
    assert PLACE in src.read_bytes()
    thumb = still_thumbnail(src, tmp_path / "poster.jpg", "png", probe_still(src, "png"))
    data = thumb.path.read_bytes()
    assert data[:3] == b"\xff\xd8\xff" and PLACE not in data and MODEL not in data and b"tEXt" not in data
    # صورة أصغر من الحد لا تُكبَّر
    assert (thumb.width, thumb.height) == _size(thumb.path) == (400, 300)


def _halves(path: Path) -> tuple[bytes, bytes]:
    """لون النصف الأعلى والنصف الأسفل (RGB) بعد تصغير الصورة إلى بكسلين."""
    raw = run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "jpeg_pipe", "-i", str(path),
               "-vf", "scale=1:2:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], timeout_s=30)
    return raw[:3], raw[3:6]


@pytest.mark.parametrize(("orientation", "top"), [(6, "red"), (8, "blue"), (3, None)])
def test_a_phone_photo_is_turned_upright_and_its_orientation_tag_is_dropped(tmp_path: Path, orientation: int, top):
    # اليسار أحمر واليمين أزرق: ربع دورة مع عقارب الساعة (6) يرفع الأحمر، وعكسها (8) يرفع الأزرق، ونصف دورة (3) يبقيها عرضية
    plain = tmp_path / "plain.jpg"
    run([FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:size=400x600",
         "-f", "lavfi", "-i", "color=blue:size=400x600", "-filter_complex", "hstack", "-frames:v", "1", str(plain)],
        timeout_s=60)
    src = _with_exif(plain, tmp_path / "IMG_0003.JPG", orientation=orientation)
    info = probe_still(src, "jpeg")
    assert (info.width, info.height) == (800, 600)
    thumb = still_thumbnail(src, tmp_path / "poster.jpg", "jpeg", info)
    assert b"Exif" not in thumb.path.read_bytes()
    if top is None:
        assert (thumb.width, thumb.height) == _size(thumb.path) == (800, 600)
        return
    assert (thumb.width, thumb.height) == _size(thumb.path) == (600, 800)
    upper, lower = _halves(thumb.path)
    red, blue = (upper, lower) if top == "red" else (lower, upper)
    assert red[0] > 180 and red[2] < 80 and blue[2] > 180 and blue[0] < 80


def test_an_image_too_large_to_decode_safely_gets_no_thumbnail(tmp_path: Path, monkeypatch):
    src = _image(tmp_path / "a.jpg", "640x480")
    monkeypatch.setattr("media_worker.stills.MAX_PIXELS", 640 * 480 - 1)
    with pytest.raises(ValueError):
        still_thumbnail(src, tmp_path / "poster.jpg", "jpeg", probe_still(src, "jpeg"))


@pytest.mark.parametrize(("head", "label"), [
    (b"\0\0\0\x18ftypheic\0\0\0\0mif1heic", "heif"),
    (b"\0\0\0\x18ftypmif1\0\0\0\0mif1heic", "heif"),
    (b"\0\0\0\x18ftypcrx \0\0\0\x01crx isom", "cr3"),
    (b"II*\0\x08\0\0\0", "tiff"),
    (b"MM\0*\0\0\0\x08", "tiff"),
])
def test_heic_and_raw_are_known_by_their_first_bytes(tmp_path: Path, head: bytes, label: str):
    src = tmp_path / "photo.bin"
    src.write_bytes(head + b"\0" * 64)
    assert opaque_still(src) == label


def test_other_files_are_not_stills(tmp_path: Path):
    clip = synth(tmp_path / "clip.mp4", seconds=1)
    text = tmp_path / "x.dng"
    text.write_bytes(b"just text, named like a raw file")
    assert opaque_still(clip) is None and opaque_still(text) is None and still_format(text) is None
