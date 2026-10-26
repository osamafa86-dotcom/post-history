"""حزمة تسليم المشتري في الخط (`license.delivery_requested`، #252): من الأصل المتحقق، لكل ترخيص حزمته، وموقَّعة C2PA
حين يُفعَّل التوقيع."""

import hashlib
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, synth
from fakes import FakeApi, FakeStorage
from media_worker.api import FileRef, Session
from media_worker.jobs import Buckets, Jobs, delivery_key

MID = "4a000000-0000-4000-8000-00000000000d"
LIC = "1c000000-0000-4000-8000-000000000001"
PRODUCED = "f0000000-0000-4000-8000-0000000000d1"


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> Path:
    return synth(tmp_path_factory.mktemp("dj") / "src.mov", seconds=2, start_offset=1, leaky_tags=True)


def _setup(data: bytes, produced: bytes | None = None, enable: bool = True):
    storage = FakeStorage()
    storage.objects[("uploads", "orig/1")] = data
    api = FakeApi(Session(id="5e000000-0000-4000-8000-00000000000d", material_id=MID, kind="original",
                          state="verified", size_bytes=len(data), storage_key="orig/1", material_has_proxy=True))
    api.original = FileRef(file_id=FakeApi.FILE_ID, material_id=MID, storage_key="orig/1", size_bytes=len(data),
                           sha256=hashlib.sha256(data).hexdigest())
    if produced is not None:
        key = f"derived/{MID}/{FakeApi.FILE_ID}/final.mp4"
        storage.objects[("media", key)] = produced
        api.files[PRODUCED] = FileRef(file_id=PRODUCED, material_id=MID, storage_key=key, size_bytes=len(produced),
                                      sha256=hashlib.sha256(produced).hexdigest(), kind="produced")
    return api, storage, Jobs(api, storage, Buckets(uploads="uploads", derived="media"), enable_delivery=enable)


def _requested(license_id=LIC, deliverables=("original", "audio", "stills"), produced=None):
    return {"type": "license.delivery_requested", "aggregate_type": "license",
            "payload": {"license_id": license_id, "material_id": MID, "source_file_id": FakeApi.FILE_ID,
                        "deliverables": list(deliverables), "produced_file_id": produced}}


def _zip(storage: FakeStorage, key: str, tmp_path: Path) -> zipfile.ZipFile:
    path = tmp_path / "d.zip"
    path.write_bytes(storage.objects[("media", key)])
    return zipfile.ZipFile(path)


def test_delivery_is_built_per_license_and_registered(clip: Path, tmp_path: Path):
    data = clip.read_bytes()
    api, storage, jobs = _setup(data)
    assert jobs.handle(_requested()) == "delivery"
    key = delivery_key(MID, FakeApi.FILE_ID, LIC)
    (fid, body), = api.derivatives
    assert fid == FakeApi.FILE_ID and body["kind"] == "delivery" and body["license_id"] == LIC
    assert body["storage_key"] == key and body["mime_type"] == "application/zip"
    assert body["sha256"] == hashlib.sha256(storage.objects[("media", key)]).hexdigest()
    with _zip(storage, key, tmp_path) as zf:
        names = zf.namelist()
        assert names[:2] == ["original.mov", "audio.wav"] and sum(n.startswith("stills/") for n in names) == 5
        for n in names:
            for value in LEAKY_TAGS.values():
                assert value.encode() not in zf.read(n)
    assert storage.objects[("uploads", "orig/1")] == data
    # ترخيص آخر حزمة أخرى، وإعادة التسليم تسجّل المرفوعة
    assert jobs.handle(_requested("1c000000-0000-4000-8000-000000000002", ["audio"])) == "delivery"
    assert jobs.handle(_requested()) == "delivery-existing"
    assert len(storage.puts) == 2 and api.derivatives[0][1] == api.derivatives[2][1]


def test_produced_comes_from_the_materials_own_derivative(clip: Path, tmp_path: Path):
    api, storage, jobs = _setup(clip.read_bytes(), produced=b"final-cut-bytes")
    assert jobs.handle(_requested(deliverables=["produced"], produced=PRODUCED)) == "delivery"
    with _zip(storage, delivery_key(MID, FakeApi.FILE_ID, LIC), tmp_path) as zf:
        assert zf.read("produced.mp4") == b"final-cut-bytes"
    api, storage, jobs = _setup(clip.read_bytes(), produced=b"final-cut-bytes")
    api.files[PRODUCED] = replace(api.files[PRODUCED], material_id="4a000000-0000-4000-8000-0000000000ff")
    with pytest.raises(ValueError):
        jobs.handle(_requested(deliverables=["produced"], produced=PRODUCED))
    assert storage.puts == []


# كل نوع غير التصدير النهائي: التحريري (R11) والداخلي والأصل نفسه
@pytest.mark.parametrize("kind", ["transcript", "captions", "shot_list", "export", "proxy", "hls", "audio",
                                  "thumbnail", "watermarked_preview", "delivery", "voice_note", "original"])
def test_produced_refuses_every_other_kind(clip: Path, kind: str):
    api, storage, jobs = _setup(clip.read_bytes(), produced=b"not-a-final-cut")
    api.files[PRODUCED] = replace(api.files[PRODUCED], kind=kind)
    with pytest.raises(ValueError, match="cannot be delivered"):
        jobs.handle(_requested(deliverables=["original", "produced"], produced=PRODUCED))
    assert storage.puts == [] and api.derivatives == []


def test_behind_flag(clip: Path):
    api, storage, jobs = _setup(clip.read_bytes(), enable=False)
    assert jobs.handle(_requested()) == "ignored" and storage.puts == []


def test_files_are_c2pa_signed_when_signing_is_on(clip: Path, tmp_path: Path):
    from media_worker import c2pa
    from test_c2pa import SECRET, _signer, make_certs
    certs = make_certs(tmp_path)
    data = clip.read_bytes()
    api, storage, jobs = _setup(data)
    jobs.c2pa = c2pa.Signing(signer=_signer(certs), source_secret=SECRET, publisher="Test Network")
    assert jobs.handle(_requested()) == "delivery"
    sha = hashlib.sha256(data).hexdigest()
    source = c2pa.source_ref(SECRET, sha)
    with _zip(storage, delivery_key(MID, FakeApi.FILE_ID, LIC), tmp_path) as zf:
        for name in ("original.mov", "audio.wav", "stills/still_03.jpg"):
            blob = zf.read(name)
            assert sha.encode() not in blob and bytes.fromhex(sha) not in blob
            f = tmp_path / Path(name).name
            f.write_bytes(blob)
            report = c2pa.read_report(f, _signer(certs), tmp_path)
            c2pa.check_report(report, source=source, publisher="Test Network", trusted=True)
        # بصمات SHA256SUMS للملفات الموقَّعة نفسها
        for line in zf.read("SHA256SUMS").decode().splitlines():
            h, n = line.split("  ")
            assert hashlib.sha256(zf.read(n)).hexdigest() == h


def test_produced_without_a_file_is_rendered_from_the_original_once(tmp_path: Path):
    from conftest import STREAM_TAGS
    from media_worker.ffmpeg import FFPROBE, run
    from media_worker.jobs import produced_key
    from media_worker.probe import probe
    # مقطع بوسوم حاوية (موقع وطراز الجهاز) ووسوم تيار، ورسالة SEI من x264 داخل تيار الفيديو
    clip = synth(tmp_path / "planted.mov", seconds=2, start_offset=1, leaky_tags=True, stream_tags=True)
    data = clip.read_bytes()
    assert b"x264 - core" in data and all(v.encode() in data for v in LEAKY_TAGS.values())
    api, storage, jobs = _setup(data)
    assert jobs.handle(_requested(deliverables=["original", "produced"])) == "delivery"
    key = produced_key(MID, FakeApi.FILE_ID)
    produced = [b for _, b in api.derivatives if b["kind"] == "produced"]
    assert len(produced) == 1 and produced[0]["storage_key"] == key and produced[0]["mime_type"] == "video/mp4"
    blob = storage.objects[("media", key)]
    assert produced[0]["sha256"] == hashlib.sha256(blob).hexdigest()
    f = tmp_path / "p.mp4"
    f.write_bytes(blob)
    got = probe(f)
    assert got.video_codec == "h264" and abs(got.duration_ms - probe(clip).duration_ms) <= 100
    # لا وسم ولا موقع ولا معرّف جهاز ولا SEI (ولا ما يكتبه المرمّز) ولا اسم الجامع
    for value in [*LEAKY_TAGS.values(), *STREAM_TAGS.values(), "x264 - core", "Lavf"]:
        assert value.encode() not in blob, value
    tags = run([FFPROBE, "-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", str(f)],
               timeout_s=30).decode()
    assert "location" not in tags.lower() and "comment" not in tags and "com.apple" not in tags
    with _zip(storage, delivery_key(MID, FakeApi.FILE_ID, LIC), tmp_path) as zf:
        assert zf.read("produced.mp4") == blob
    # ترخيص ثانٍ يعيد استعمال النسخة المنتَجة المرفوعة ولا يبني غيرها
    puts = len(storage.puts)
    assert jobs.handle(_requested("1c000000-0000-4000-8000-000000000003", ["produced"])) == "delivery"
    assert len(storage.puts) == puts + 1  # الحزمة الجديدة وحدها
    assert storage.objects[("uploads", "orig/1")] == data
