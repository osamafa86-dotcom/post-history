"""بدائل في الذاكرة للخادم والتخزين والمحرك وRedis؛ تسجّل ما استُدعي لتتحقق منه الاختبارات."""

from __future__ import annotations

import hashlib
from pathlib import Path

from ai_worker.api import ApiRejected
from ai_worker.captions import Segment, Word
from ai_worker.storage import ObjectMissing
from ai_worker.transcribe import MediaTiming, Transcript

MATERIAL = "a0000000-0000-4000-8000-000000000001"
FILE = "f0000000-0000-4000-8000-000000000001"
BUCKET = "media"


def verified_event(**payload) -> dict:
    p = {"material_id": MATERIAL, "file_id": FILE, "upload_session_id": "50000000-0000-4000-8000-000000000001",
         "kind": "original", **payload}
    return {"id": "1", "type": "upload.verified", "aggregate_type": "upload", "aggregate_id": p["upload_session_id"],
            "occurred_at": "2026-10-20T00:00:00Z", "idempotency_key": "upload.verified:x", "payload": p}


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.puts: list[tuple[str, str, str]] = []
        self.heads = 0

    def head(self, bucket: str, key: str) -> int:
        self.heads += 1
        try:
            return len(self.objects[(bucket, key)])
        except KeyError:
            raise ObjectMissing("missing") from None

    def read(self, bucket: str, key: str, chunk_size: int = 1024 * 1024):
        try:
            data = self.objects[(bucket, key)]
        except KeyError:
            raise ObjectMissing("missing") from None
        for i in range(0, len(data), chunk_size):
            yield data[i:i + chunk_size]

    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None:
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha256_hex
        self.objects[(bucket, key)] = data
        self.puts.append((bucket, key, content_type))


class FakeApi:
    """Mimics POST /internal/media/files/{id}/derivatives: path rule, idempotent replay, 409 on a different file."""

    def __init__(self, reject_kinds: tuple[str, ...] = ()) -> None:
        self.reject_kinds = reject_kinds
        self.derivatives: dict[tuple[str, str], dict] = {}
        self.calls = 0

    def add_derivative(self, file_id: str, body: dict) -> dict:
        self.calls += 1
        assert body["storage_key"].startswith(f"derived/{MATERIAL}/{file_id}/")
        if body["kind"] in self.reject_kinds:
            raise ApiRejected("POST derivatives: HTTP 422")
        prev = self.derivatives.get((file_id, body["kind"]))
        assert prev is None or prev["sha256"] == body["sha256"], "replay must carry the same file"
        self.derivatives[(file_id, body["kind"])] = body
        return {"file_id": "d0000000-0000-4000-8000-000000000001"}


class FakeEngine:
    describe = {"name": "fake", "vad": "none"}

    def __init__(self, segments: list[Segment] | None = None, start_pts_us: int = 0) -> None:
        self.calls = 0
        self.start_pts_us = start_pts_us
        self.segments = segments if segments is not None else [
            Segment(0.0, 4.0, " وصل الوفد إلى غزة",
                    (Word(0.52, 0.9, " وصل", 0.9), Word(0.95, 1.4, " الوفد", 0.8),
                     Word(1.45, 1.7, " إلى", 0.95), Word(1.75, 2.3, " غزة", 0.7))),
        ]

    def transcribe(self, path: Path) -> Transcript:
        assert path.exists()
        self.calls += 1
        return Transcript(self.segments, MediaTiming(duration_s=12.5, start_pts_us=self.start_pts_us,
                                                     audio_offset_s=0.0), decode_s=0.1, transcribe_s=0.2)


class FakeRedis:
    """What Service.process touches: pending count, ack, dead-letter append, claim."""

    def __init__(self, delivered: int = 1) -> None:
        self.delivered = delivered
        self.acked: list[str] = []
        self.added: list[tuple[str, dict]] = []
        self.claims = 0

    def xpending_range(self, stream, group, min, max, count):
        return [{"times_delivered": self.delivered}]

    def xack(self, stream, group, entry_id):
        self.acked.append(entry_id)

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        self.added.append((stream, fields))

    def xclaim(self, *a, **k):
        self.claims += 1

    # ai:retry
    zset: dict = {}

    def zadd(self, key, mapping):
        self.zset = {**self.zset, **mapping}

    def zrangebyscore(self, key, lo, hi, start=0, num=None):
        return [m for m, s in sorted(self.zset.items(), key=lambda kv: kv[1]) if s <= hi][start:start + (num or 10**9)]

    def zrem(self, key, member):
        return 1 if self.zset.pop(member, None) is not None else 0
