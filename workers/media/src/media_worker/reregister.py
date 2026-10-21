"""إعادة تسجيل المشتقات التي رفض الخادم نوعها (422) قبل أن يقبله العقد: `waveform.json` (`audio`)، و`poster.jpg`
(`thumbnail`)، و`hls/index.m3u8` (`hls`). الملفات في مكانها تحت `derived/<material_id>/<file_id>/`، فتُقرأ وتُحسب
بصمتها وتُسجَّل كما هي، بلا ترميز ولا كتابة في التخزين. التسجيل المكرر المطابق يقبله الخادم، والمخالف 409 يُترك.

    python -m media_worker reregister <material_id>:<file_id> [...]

البيانات الفنية من النسخة الخفيفة المسجلة (المدة و`start_pts` الأصل محفوظان فيها)، وأبعاد الملصق من ترويسة JPEG.
وقت الملصق نفسه لا يُستعاد من الملف، فيُسجَّل `start_pts_us` له ببداية المقطع.
"""

from __future__ import annotations

import json
import struct
import tempfile
from pathlib import Path

from .api import ApiConflict, ApiRejected
from .jobs import Jobs, _download, hls_prefix, poster_key, proxy_key, waveform_key
from .probe import probe
from .storage import ObjectMissing


def jpeg_size(data: bytes) -> tuple[int, int]:
    """(العرض، الارتفاع) من أول مقطع SOF في JPEG."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            raise ValueError("not a JPEG marker")
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise ValueError("no SOF segment")


def reregister(jobs: Jobs, material_id: str, file_id: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with tempfile.TemporaryDirectory(dir=jobs.scratch, prefix="rereg-") as tmp:
        d = Path(tmp)
        try:
            _download(jobs.storage, jobs.buckets.derived, proxy_key(material_id, file_id), d / "proxy.mp4")
        except ObjectMissing:
            return {"proxy": "absent"}
        ref = probe(d / "proxy.mp4")
        items = [
            ("audio", waveform_key(material_id, file_id), "waveform.json"),
            ("thumbnail", poster_key(material_id, file_id), "poster.jpg"),
            ("hls", hls_prefix(material_id, file_id) + "index.m3u8", "index.m3u8"),
        ]
        for kind, key, name in items:
            try:
                digest = _download(jobs.storage, jobs.buckets.derived, key, d / name)
            except ObjectMissing:
                out[kind] = "absent"
                continue
            if kind == "audio":
                wave = json.loads((d / name).read_text())
                technical = {"duration_ms": int(wave["duration_ms"]), "start_pts_us": ref.start_pts_us,
                             "container": "json"}
            elif kind == "thumbnail":
                w, h = jpeg_size((d / name).read_bytes())
                technical = {"duration_ms": 0, "start_pts_us": ref.start_pts_us, "width": w, "height": h,
                             "container": "jpeg", "video_codec": "mjpeg"}
            else:
                technical = ref.to_dict()
            body = {"kind": kind, "storage_key": key, "sha256": digest.sha256, "size_bytes": digest.size_bytes,
                    "technical": technical}
            try:
                jobs.api.add_derivative(file_id, body)
                out[kind] = "registered"
            except ApiConflict:
                out[kind] = "conflict"
            except ApiRejected:
                out[kind] = "rejected"
    return out


def main(pairs: list[str]) -> None:
    from .api import InternalApi
    from .jobs import Buckets
    from .service import Config
    from .storage import S3Storage

    cfg = Config.from_env()
    storage = S3Storage(cfg.s3_endpoint, cfg.s3_region, cfg.s3_access_key, cfg.s3_secret_key, cfg.bucket_derived)
    jobs = Jobs(InternalApi(cfg.api_url, cfg.token), storage, Buckets(cfg.bucket_uploads, cfg.bucket_derived),
                cfg.scratch)
    for pair in pairs:
        material_id, _, file_id = pair.partition(":")
        print(json.dumps({"material_id": material_id, "file_id": file_id, **reregister(jobs, material_id, file_id)}))
