"""بدائل في الذاكرة للخادم والتخزين؛ تسجّل ما استُدعي لتتحقق منه الاختبارات."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from media_worker.api import ApiRejected, FileRef, Session
from media_worker.storage import ObjectMissing


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.puts: list[tuple[str, str]] = []

    def read(self, bucket: str, key: str, chunk_size: int = 1024 * 1024):
        try:
            data = self.objects[(bucket, key)]
        except KeyError:
            raise ObjectMissing("missing") from None
        for i in range(0, len(data), chunk_size):
            yield data[i:i + chunk_size]

    def head(self, bucket: str, key: str) -> int:
        try:
            return len(self.objects[(bucket, key)])
        except KeyError:
            raise ObjectMissing("missing") from None

    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None:
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha256_hex
        self.objects[(bucket, key)] = data
        self.puts.append((bucket, key))


class FakeApi:
    """Mimics the server side of ADR 0006 (apps/api/src/media): decides, replays, refuses mismatches."""

    FILE_ID = "f0000000-0000-4000-8000-000000000001"

    def __init__(self, session: Session, reject_thumbnails: bool = False) -> None:
        self.session = session
        self.reject_thumbnails = reject_thumbnails
        self.verifications: list[dict] = []
        self.derivatives: list[tuple[str, dict]] = []
        self.sha256: str | None = None

    def get_session(self, session_id: str) -> Session:
        assert session_id == self.session.id
        return self.session

    def report_verification(self, session_id: str, body: dict) -> dict:
        self.verifications.append(body)
        if body["result"] != "verified":
            # the server's schema forbids a hash or technical data on a failure report
            assert "sha256" not in body and "technical" not in body
        if self.session.state == "verified":
            assert body.get("sha256") == self.sha256, "replay must match"
        elif body["result"] == "verified":
            self.sha256 = body["sha256"]
            self.session = replace(self.session, state="verified")
        else:
            self.session = replace(self.session, state="failed")
            return {"state": "failed", "file_id": None, "failure_reason": body["result"]}
        return {"state": "verified", "file_id": self.FILE_ID, "receipt_number": None, "failure_reason": None}

    def add_derivative(self, file_id: str, body: dict) -> dict:
        assert body["storage_key"].startswith(f"derived/{self.session.material_id}/{file_id}/")
        if body["kind"] == "thumbnail" and self.reject_thumbnails:
            raise ApiRejected("POST derivatives: HTTP 422")  # كما يرد الخادم قبل أن يقبل نوع thumbnail
        self.derivatives.append((file_id, body))
        if body["kind"] == "proxy":
            self.session = replace(self.session, material_has_proxy=True)
        return {"file_id": "d0000000-0000-4000-8000-000000000001"}

    def get_material_original(self, material_id: str) -> FileRef:
        assert material_id == self.session.material_id
        return self.original
