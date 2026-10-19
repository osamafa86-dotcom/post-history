"""بصمة الأصل في قراءة تدفقية واحدة: SHA-256 الكاملة والبصمة الرخيصة (رأس + ذيل) معًا.

البصمة الرخيصة تطابق `client_fingerprint` في العقد (`size_bytes`، `head_sha256` لأول ميغابايت،
`tail_sha256` لآخر ميغابايت) وترشّح المكررات فقط ولا تمنح حقًا؛ الربط بملف موجود لا يتم إلا بتطابق SHA-256
الكاملة. الميغابايت هنا 1 MiB (1,048,576 بايت)، وملف أصغر منه رأسه وذيله الملف كله.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

FINGERPRINT_SPAN = 1024 * 1024
CHUNK = 8 * 1024 * 1024


@dataclass(frozen=True)
class Digest:
    sha256: str
    size_bytes: int
    head_sha256: str
    tail_sha256: str

    def fingerprint(self) -> dict:
        return {"size_bytes": self.size_bytes, "head_sha256": self.head_sha256, "tail_sha256": self.tail_sha256}


def digest_stream(chunks: Iterable[bytes]) -> Digest:
    """يستهلك التدفق مرة واحدة. الذاكرة ثابتة: الرأس والذيل ميغابايت لكل منهما مهما كبر الملف."""
    full = hashlib.sha256()
    head = bytearray()
    tail = bytearray()
    size = 0
    for chunk in chunks:
        if not chunk:
            continue
        full.update(chunk)
        size += len(chunk)
        if len(head) < FINGERPRINT_SPAN:
            head += chunk[: FINGERPRINT_SPAN - len(head)]
        tail += chunk[-FINGERPRINT_SPAN:]
        if len(tail) > FINGERPRINT_SPAN:
            del tail[: len(tail) - FINGERPRINT_SPAN]
    return Digest(
        sha256=full.hexdigest(),
        size_bytes=size,
        head_sha256=hashlib.sha256(head).hexdigest(),
        tail_sha256=hashlib.sha256(tail).hexdigest(),
    )


def read_chunks(path: Path, chunk_size: int = CHUNK) -> Iterable[bytes]:
    with open(path, "rb") as fh:
        while chunk := fh.read(chunk_size):
            yield chunk


def digest_file(path: Path) -> Digest:
    return digest_stream(read_chunks(path))


def fingerprint_matches(client: dict | None, digest: Digest) -> bool:
    """هل تطابق بصمة العميل الرخيصة ما حُسب على الخادم. مقارنة ثابتة الزمن لأن القيم من مصدر غير موثوق."""
    if not client:
        return False
    try:
        return (
            int(client["size_bytes"]) == digest.size_bytes
            and hmac.compare_digest(str(client["head_sha256"]).lower(), digest.head_sha256)
            and hmac.compare_digest(str(client["tail_sha256"]).lower(), digest.tail_sha256)
        )
    except (KeyError, TypeError, ValueError):
        return False
