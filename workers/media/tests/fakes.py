"""بدائل في الذاكرة للخادم والتخزين؛ تسجّل ما استُدعي لتتحقق منه الاختبارات."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from media_worker.api import Session
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

    def put_file(self, bucket: str, key: str, path: Path, sha256_hex: str, content_type: str) -> None:
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha256_hex
        self.objects[(bucket, key)] = data
        self.puts.append((bucket, key))


class FakeApi:
    def __init__(self, session: Session) -> None:
        self.session = session
        self.verifications: list[dict] = []
        self.derivatives: list[tuple[str, dict]] = []

    def get_session(self, session_id: str) -> Session:
        assert session_id == self.session.id
        return self.session

    def report_verification(self, session_id: str, body: dict) -> dict:
        self.verifications.append(body)
        if body["result"] == "verified":
            self.session = replace(self.session, state="verified", file_id="f0000000-0000-4000-8000-000000000001")
        else:
            self.session = replace(self.session, state="failed")
        return {"file_id": self.session.file_id}

    def add_derivative(self, file_id: str, body: dict) -> dict:
        self.derivatives.append((file_id, body))
        return {}
