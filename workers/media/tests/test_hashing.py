import hashlib
import os
from pathlib import Path

import pytest

from media_worker.hashing import FINGERPRINT_SPAN, digest_file, digest_stream, fingerprint_matches, read_chunks


def _expected(data: bytes) -> tuple[str, str, str]:
    h = hashlib.sha256
    return h(data).hexdigest(), h(data[:FINGERPRINT_SPAN]).hexdigest(), h(data[-FINGERPRINT_SPAN:]).hexdigest()


SPAN = FINGERPRINT_SPAN


@pytest.mark.parametrize("size", [0, 1, SPAN - 1, SPAN, SPAN + 1, 5 * SPAN + 123])
@pytest.mark.parametrize("chunk", [1000, 64 * 1024, 3 * FINGERPRINT_SPAN])
def test_matches_whole_buffer_hashes_for_any_chunking(tmp_path: Path, size: int, chunk: int):
    data = os.urandom(size)
    f = tmp_path / "blob"
    f.write_bytes(data)
    d = digest_stream(read_chunks(f, chunk))
    full, head, tail = _expected(data)
    assert (d.sha256, d.head_sha256, d.tail_sha256, d.size_bytes) == (full, head, tail, size)


def test_original_is_not_modified(tmp_path: Path):
    f = tmp_path / "orig"
    f.write_bytes(os.urandom(3 * FINGERPRINT_SPAN))
    before = (f.stat().st_mtime_ns, hashlib.sha256(f.read_bytes()).hexdigest())
    digest_file(f)
    assert (f.stat().st_mtime_ns, hashlib.sha256(f.read_bytes()).hexdigest()) == before


def test_fingerprint_comparison(tmp_path: Path):
    f = tmp_path / "x"
    f.write_bytes(os.urandom(2 * FINGERPRINT_SPAN + 7))
    d = digest_file(f)
    assert fingerprint_matches(d.fingerprint(), d)
    assert fingerprint_matches({**d.fingerprint(), "head_sha256": d.head_sha256.upper()}, d)
    assert not fingerprint_matches({**d.fingerprint(), "size_bytes": d.size_bytes + 1}, d)
    assert not fingerprint_matches({**d.fingerprint(), "tail_sha256": "0" * 64}, d)
    assert not fingerprint_matches(None, d)
    assert not fingerprint_matches({"size_bytes": "x"}, d)
