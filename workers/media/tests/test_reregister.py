"""إعادة التسجيل: مشتقات رُفض نوعها تُسجَّل كما هي بعد أن يقبلها الخادم، بلا كتابة في التخزين."""

from conftest import synth
from fakes import FakeApi
from media_worker.reregister import jpeg_size, reregister
from test_jobs import MID, _event, _setup


def test_rejected_thumbnail_is_registered_later(tmp_path):
    api, storage, jobs = _setup(synth(tmp_path / "s.mov", seconds=3, start_offset=2).read_bytes(),
                                reject_thumbnails=True)
    jobs.handle(_event())
    assert [d["kind"] for _, d in api.derivatives] == ["audio", "proxy"]
    puts = len(storage.puts)
    api.reject_thumbnails = False  # العقد قبل النوع
    r = reregister(jobs, MID, FakeApi.FILE_ID)
    assert r == {"audio": "registered", "thumbnail": "registered", "hls": "absent"}
    thumb = next(d for _, d in api.derivatives if d["kind"] == "thumbnail")
    assert (thumb["technical"]["width"], thumb["technical"]["height"]) == (640, 360)
    assert thumb["technical"]["start_pts_us"] == 2_000_000 and len(storage.puts) == puts


def test_missing_proxy_is_reported(tmp_path):
    api, storage, jobs = _setup(b"x")
    assert reregister(jobs, MID, FakeApi.FILE_ID) == {"proxy": "absent"}


def test_jpeg_size():
    # SOI ثم SOF0 بطول 17: دقة 8، ارتفاع 0x0168 (360)، عرض 0x0280 (640)
    data = b"\xff\xd8" + b"\xff\xc0\x00\x11\x08\x01\x68\x02\x80" + b"\x00" * 12
    assert jpeg_size(data) == (640, 360)
